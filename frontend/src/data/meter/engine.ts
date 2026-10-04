import type {
  ExportJob,
  ImportedReadingRow,
  ImportResult,
  MeterPoint,
  ReadingRecord,
  SettlementDraft,
} from './types'

export type PeriodReading = ReadingRecord & { meter: MeterPoint }

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export function isValidPeriod(value: string): boolean {
  if (!PERIOD_RE.test(value)) {
    return false
  }
  return true
}

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime())
}

/** 倍率校验：写入前统一过这一道，非正数 / 非数字 / 无穷一律拒绝。 */
export function validateRatio(ratio: number): string | null {
  if (typeof ratio !== 'number' || Number.isNaN(ratio) || !Number.isFinite(ratio)) {
    return '倍率必须是数字'
  }
  if (ratio <= 0) {
    return '倍率必须大于 0'
  }
  if (ratio > 1_000_000) {
    return '倍率超出合理上限（1000000），请核对互感器铭牌'
  }
  return null
}

export function roundEnergy(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** 本期电量：(本期读数 - 上期读数) × 倍率。换表倒行时按新表起算（上期按 0）。 */
export function computeEnergy(current: number, previous: number, ratio: number, resetMeter = false): number {
  const base = resetMeter ? 0 : previous
  return roundEnergy((current - base) * ratio)
}

/** 按生效日期解析某一天适用的倍率；倍率历史自投运时间补起，正常总能取到投运那一笔。 */
export function ratioOnDate(meter: MeterPoint, date: string): number {
  const sorted = [...meter.ratioHistory].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
  let picked = sorted[0]?.ratio ?? meter.ratio
  for (const item of sorted) {
    if (item.effectiveDate <= date) {
      picked = item.ratio
    }
  }
  return picked
}

/**
 * 上期读数取哪一版：取该计量点「本周期之前最近一笔已复核确认」的归档值。
 * 已确认读数复核时归档，之后任何操作都不允许覆盖；找不到归档时回退装表底数。
 * 老单据（legacy）同样按归档值参与，旧单据照旧兼容。
 */
export function resolvePrevious(readings: ReadingRecord[], meter: MeterPoint, period: string): number {
  const confirmed = readings
    .filter((item) => item.meterId === meter.id && item.status === '已确认' && item.period < period)
    .sort((a, b) => b.period.localeCompare(a.period))
  const latest = confirmed[0]
  if (latest) {
    return latest.archivedValue ?? latest.current
  }
  return meter.baseReading
}

export function readingsOfMeter(readings: ReadingRecord[], meterId: number): ReadingRecord[] {
  return readings
    .filter((item) => item.meterId === meterId)
    .sort((a, b) => b.period.localeCompare(a.period) || b.readDate.localeCompare(a.readDate))
}

/**
 * 改倍率后的重算：只重算尚未复核确认（未归档）的抄录，已确认期间的账冻结不动。
 * 每条按其抄表日期重新解析生效倍率，保证面板、导出、结算三处看到的是同一个数。
 */
export function recomputeOpenReadings(readings: ReadingRecord[], meter: MeterPoint): ReadingRecord[] {
  return readings.map((item) => {
    if (item.meterId !== meter.id || item.status === '已确认') {
      return item
    }
    const ratio = ratioOnDate(meter, item.readDate)
    if (ratio === item.ratio) {
      return item
    }
    return { ...item, ratio, energy: computeEnergy(item.current, item.previous, ratio, item.resetMeter) }
  })
}

/** 发电结算待核算清单：来源只有一个——已确认抄录记录本身，两处本期电量天然对得上。 */
export function settlementDrafts(meters: MeterPoint[], readings: ReadingRecord[]): SettlementDraft[] {
  const confirmed = readings.filter(
    (item) => item.status === '已确认' && !item.legacy,
  ) as PeriodReading[]
  const grouped = new Map<string, { meter: MeterPoint; items: ReadingRecord[] }>()
  for (const item of confirmed) {
    const meter = meters.find((point) => point.id === item.meterId)
    if (!meter || meter.direction !== '上网关口') {
      continue
    }
    const key = `${meter.stationId}|${item.period}`
    const bucket = grouped.get(key) ?? { meter, items: [] }
    bucket.items.push(item)
    grouped.set(key, bucket)
  }
  return [...grouped.entries()]
    .sort(([, a], [, b]) => 0)
    .map(([key, bucket]) => {
      const [stationId, period] = key.split('|')
      const items = bucket.items.sort((a, b) => a.meterId - b.meterId)
      return {
        // 电站+周期确定一张待核算单，复核多笔也只更新同一张，不会重复挂账。
        no: `SETT-${period}-${stationId}`,
        period,
        stationId,
        stationName: bucket.meter.stationName,
        energy: roundEnergy(items.reduce((sum, item) => sum + item.energy, 0)),
        readingIds: items.map((item) => item.id),
      }
    })
    .sort((a, b) => a.period.localeCompare(b.period))
}

// ---------- 批量导入解析（CSV） ----------

const IMPORT_HEADER = ['计量点编号', '周期', '抄表日期', '本期读数']

export function parseImportCsv(text: string): { rows: ImportedReadingRow[]; errors: { row: number; reason: string }[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) {
    return { rows: [], errors: [{ row: 0, reason: '文件为空' }] }
  }
  const header = lines[0].split(',').map((cell) => cell.trim())
  const missingCols = IMPORT_HEADER.filter((col) => !header.includes(col))
  if (missingCols.length) {
    return { rows: [], errors: [{ row: 1, reason: `表头缺少列：${missingCols.join('、')}` }] }
  }
  const rows: ImportedReadingRow[] = []
  const errors: { row: number; reason: string }[] = []
  const seen = new Set<string>()
  for (let i = 1; i < lines.length; i += 1) {
    const lineNo = i + 1
    const cells = lines[i].split(',').map((cell) => cell.trim())
    const [code, period, readDate, rawCurrent] = cells
    if (!code || !period || !readDate || rawCurrent === undefined) {
      errors.push({ row: lineNo, reason: '列不完整' })
      continue
    }
    if (!isValidPeriod(period)) {
      errors.push({ row: lineNo, reason: `周期格式应为 YYYY-MM：${period}` })
      continue
    }
    if (!isValidDate(readDate)) {
      errors.push({ row: lineNo, reason: `抄表日期格式应为 YYYY-MM-DD：${readDate}` })
      continue
    }
    const current = Number(rawCurrent)
    if (Number.isNaN(current) || !Number.isFinite(current) || current < 0) {
      errors.push({ row: lineNo, reason: `本期读数不是合法非负数字：${rawCurrent}` })
      continue
    }
    const dupKey = `${code}|${period}`
    if (seen.has(dupKey)) {
      errors.push({ row: lineNo, reason: `同一计量点同一周期在文件里出现了两次：${code} ${period}` })
      continue
    }
    seen.add(dupKey)
    rows.push({ code, period, readDate, current, legacy: true })
  }
  return { rows, errors }
}

/**
 * 导入前干跑校验：
 * - 未知计量点编号 → 点名到 CSV 行号，整批退回；
 * - 已存在（含老单据）的计量点+周期 → 点名到行号，不重复灌账；
 * - 登记在册但本批缺失的计量点 → 点名编号，需要显式确认才放行。
 */
export function dryRunImport(
  parsed: ImportedReadingRow[],
  parseErrors: { row: number; reason: string }[],
  meters: MeterPoint[],
  readings: ReadingRecord[],
  allowMissing: boolean,
): ImportResult {
  const unknownPointRows: { row: number; code: string }[] = []
  const existingRows: { row: number; code: string }[] = []
  const present = new Set<number>()
  parsed.forEach((row, index) => {
    const lineNo = index + 2
    const meter = meters.find((point) => point.code === row.code)
    if (!meter) {
      unknownPointRows.push({ row: lineNo, code: row.code })
      return
    }
    present.add(meter.id)
    if (readings.some((item) => item.meterId === meter.id && item.period === row.period)) {
      existingRows.push({ row: lineNo, code: row.code })
    }
  })
  const missingPointCodes = meters.filter((meter) => !present.has(meter.id)).map((meter) => meter.code)
  const problems = [
    ...parseErrors.map((item) => `第 ${item.row} 行：${item.reason}`),
    ...unknownPointRows.map((item) => `第 ${item.row} 行：计量点编号 ${item.code} 不在册`),
    ...existingRows.map((item) => `第 ${item.row} 行：${item.code} 该周期已有抄录，禁止重复灌账`),
  ]
  if (problems.length) {
    return {
      ok: false,
      message: `导入校验未通过，整笔退回：\n${problems.join('\n')}`,
      inserted: 0,
      unknownPointRows,
      missingPointCodes,
    }
  }
  if (missingPointCodes.length && !allowMissing) {
    return {
      ok: false,
      message: `以下在册计量点本批文件里缺抄录，确认仍要导入吗：${missingPointCodes.join('、')}`,
      inserted: 0,
      unknownPointRows,
      missingPointCodes,
    }
  }
  return {
    ok: true,
    message: `校验通过，可导入 ${parsed.length} 笔${missingPointCodes.length ? `（已确认缺 ${missingPointCodes.length} 个计量点：${missingPointCodes.join('、')}）` : ''}`,
    inserted: parsed.length,
    unknownPointRows,
    missingPointCodes,
  }
}

// ---------- 导出 / 打印：与详情面板同源 ----------

export type PanelSnapshot = {
  filename: string
  meter: MeterPoint
  infoRows: [string, string][]
  ratioRows: RatioChangeLike[]
  readingRows: Array<Record<string, string | number>>
}

type RatioChangeLike = { effectiveDate: string; ratio: number; operator: string; reason: string }

/** 详情面板快照：页面展示、下载文件、打印任务都从这一份拼装，看到什么就能打出什么。 */
export function buildPanelSnapshot(
  meter: MeterPoint,
  readings: ReadingRecord[],
  settlementNos: Set<number | string>,
): PanelSnapshot {
  const infoRows: [string, string][] = [
    ['计量点编号', meter.code],
    ['计量方向', meter.direction],
    ['表计型号', meter.model],
    ['所属电站', `${meter.stationName}（${meter.stationId}）`],
    ['投运日期', meter.commissionDate],
    ['装表底数', String(meter.baseReading)],
    ['当前倍率', String(meter.ratio)],
  ]
  const ratioRows = [...meter.ratioHistory].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
  const readingRows = readingsOfMeter(readings, meter.id).map((item) => ({
    周期: item.period,
    抄表日期: item.readDate,
    上期读数: item.previous,
    本期读数: item.current,
    适用倍率: item.ratio,
    本期电量: item.energy,
    计量状态: item.status,
    单据来源: item.legacy ? '历史老单据' : '本期抄录',
    结算单号: item.settlementNo ?? (settlementNos.has(item.id) ? draftNoFor(meter, item.period) : '—'),
    抄表人: item.submittedBy,
    复核人: item.reviewedBy ?? '—',
  }))
  return {
    filename: `关口计量表-${meter.code}-抄录明细.csv`,
    meter,
    infoRows,
    ratioRows,
    readingRows,
  }
}

export function draftNoFor(meter: MeterPoint, period: string): string {
  return `SETT-${period}-${meter.stationId}`
}

/** 快照序列化为 CSV：下载与打印内容都由这里出，天然同一份。 */
export function serializeSnapshot(snapshot: PanelSnapshot): string {
  const esc = (value: unknown) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines: string[] = []
  lines.push('# 关口计量表抄录明细（与详情面板一致）')
  for (const [label, value] of snapshot.infoRows) {
    lines.push([esc(label), esc(value)].join(','))
  }
  lines.push('')
  lines.push('# 倍率历史（自投运时间补起）')
  lines.push(['生效日期', '倍率', '操作人', '事由'].join(','))
  for (const row of snapshot.ratioRows) {
    lines.push([row.effectiveDate, row.ratio, esc(row.operator), esc(row.reason)].join(','))
  }
  lines.push('')
  lines.push('# 抄录记录')
  const header = Object.keys(snapshot.readingRows[0] ?? {
    周期: '', 抄表日期: '', 上期读数: '', 本期读数: '', 适用倍率: '', 本期电量: '', 计量状态: '', 单据来源: '', 结算单号: '', 抄表人: '', 复核人: '',
  })
  lines.push(header.join(','))
  for (const row of snapshot.readingRows) {
    lines.push(header.map((col) => esc(row[col])).join(','))
  }
  return `﻿${lines.join('\n')}`
}

/** 切块：一行一块，每块独立完整，中断时整块未完成就不进文件，杜绝半包。 */
export function toChunks(content: string): string[] {
  return content.split('\n').map((line, index, all) => (index < all.length - 1 ? `${line}\n` : line))
}

export function assembleJob(job: ExportJob): string {
  return job.chunks.join('')
}

export function jobPercent(job: ExportJob): number {
  if (job.total === 0) {
    return 0
  }
  return Math.round((job.cursor / job.total) * 100)
}
