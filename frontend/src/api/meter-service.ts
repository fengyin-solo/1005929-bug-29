/**
 * 电量计量领域服务：抄录一次落定、上期读数归档冻结、倍率版本化、
 * 复核结果落发电结算待核算清单、批量灌档点名缺行、导出/打印同源可续打。
 * 页面只做渲染和交互，所有业务判断集中在本文件。
 */
import { SEED_ROWS } from '@/data/seed'
import { clone, commitTables, listRows, withTransaction } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  MeterArchiveEntry,
  MeterImportBatch,
  MeterPoint,
  MeterRatioChange,
  MeterReadStatus,
  MeterReading,
  PrintJob,
  SettlementItem,
} from '@/data/types'
import type { OperatorProfile } from '@/stores/session'

// 本地表键：meter 仍是中文列主表（供通用导出/看板），其余为领域表
const T_MASTER = 'meter'
const T_READ = 'meterReadings'
const T_ARCHIVE = 'meterArchives'
const T_RATIO = 'meterRatios'
const T_SETTLE = 'settlementItems'
const T_IMPORT = 'meterImports'
const T_PRINT = 'printJobs'

type Draft = Record<string, EntryRow[]>

type ServiceResult<T = undefined> = ActionResult & { data?: T }

export type MeterDetail = {
  point: MeterPoint
  reading: MeterReading | null
  previous: { reading: number; source: string; period: string } | null
  archives: MeterArchiveEntry[]
  ratios: MeterRatioChange[]
  settlementItems: SettlementItem[]
}

type CaptureInput = {
  pointCode: string
  period: string
  readDate: string
  currentReading: number
  operator: OperatorProfile
  requestToken?: string
  manualPrevious?: number
}

type ReviewInput = {
  pointCode: string
  period: string
  operator: OperatorProfile
  reason?: string
}

type RatioInput = {
  pointCode: string
  ratio: number
  effectiveDate: string
  reason: string
  operator: OperatorProfile
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

function table<T>(key: string): T[] {
  return listRows(key) as unknown as T[]
}

function draftTable<T>(draft: Draft, key: string): T[] {
  return (draft[key] ?? []) as unknown as T[]
}

function nextId<T extends { id: number }>(rows: T[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

export function periodOf(dateText: string): string {
  return dateText.slice(0, 7)
}

function endOfPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number)
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`结算周期 ${period} 不是合法的 YYYY-MM`)
  }
  return new Date(year, month, 0).toISOString().slice(0, 10)
}

function isDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00`).getTime())
}

function roundEnergy(diff: number, ratio: number): number {
  // 电量取整到千瓦时，避免半度小数在结算两边对不上
  return Math.round(diff * ratio)
}

export function hashText(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33) ^ text.charCodeAt(i)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function makeToken(parts: (string | number)[]): string {
  return `md-${parts.join('-')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function csvEscape(value: string | number): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// ── 主数据与查询 ──────────────────────────────────────────────────────────────

/** 中文列主表 → 计量点对象；电站编号在主表里随电站名冗余一列 */
function toPoint(row: EntryRow): MeterPoint {
  return {
    id: Number(row.id),
    pointCode: String(row['计量点编号'] ?? ''),
    stationCode: String(row['电站编号'] ?? ''),
    stationName: String(row['所属电站'] ?? ''),
    direction: String(row['计量方向'] ?? ''),
    meterModel: String(row['表计型号'] ?? ''),
    ratio: Number(row['倍率'] ?? 0),
    commissioningDate: String(row['投运日期'] ?? ''),
    status: String(row['计量状态'] ?? row.status ?? '待抄表') as MeterReadStatus,
  }
}

function toMasterRow(point: MeterPoint, extra: Partial<EntryRow> = {}): EntryRow {
  return {
    id: point.id,
    status: point.status,
    pending: point.status !== '已确认',
    abnormal: point.status === '已驳回',
    '计量点编号': point.pointCode,
    '电站编号': point.stationCode,
    '所属电站': point.stationName,
    '计量方向': point.direction,
    '表计型号': point.meterModel,
    '倍率': point.ratio,
    '投运日期': point.commissioningDate,
    '结算周期': '',
    '抄表日期': '',
    '本期读数': '',
    '上期读数': '',
    '本期电量': '',
    '计量状态': point.status,
    ...extra,
  }
}

export function listMeterPoints(stationCode?: string): MeterPoint[] {
  const points = table<EntryRow>(T_MASTER).map(toPoint)
  return stationCode ? points.filter((point) => point.stationCode === stationCode) : points
}

export function getPoint(pointCode: string): MeterPoint | null {
  return listMeterPoints().find((point) => point.pointCode === pointCode) ?? null
}

export function latestPeriod(pointCode: string): string {
  const periods = table<MeterReading>(T_READ)
    .filter((row) => row.pointCode === pointCode)
    .map((row) => row.period)
    .sort()
  return periods.length ? periods[periods.length - 1] : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
}

function findReading(rows: MeterReading[], pointCode: string, period: string): MeterReading | undefined {
  return rows.find((row) => row.pointCode === pointCode && row.period === period)
}

function ratioFor(pointCode: string, period: string, draft?: Draft): MeterRatioChange | null {
  const boundary = endOfPeriod(period)
  const source = draft ? draftTable<MeterRatioChange>(draft, T_RATIO) : table<MeterRatioChange>(T_RATIO)
  const hits = source
    .filter((row) => row.pointCode === pointCode && row.effectiveDate <= boundary)
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1))
  return hits[0] ?? null
}

function previousMonth(period: string): string {
  const [year, month] = period.split('-').map(Number)
  const date = new Date(year, month - 2, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 上期读数取值（归档优先，老单据兼容；取早于本期的最近一期，漏抄月份不会断链）：
 * 1. 归档表有更早周期记录 → 取其中最近周期的最新版本（同周期旧版本留档不删，这一版由本服务权衡）；
 * 2. 老数据没有归档 → 回退更早周期已确认抄表记录的本期读数；
 * 3. 再没有就交给抄录人手工录入，取不到数不替它填 0。
 */
function resolvePrevious(
  pointCode: string,
  period: string,
  manual?: number,
  sourceRows?: { archives: MeterArchiveEntry[]; reads: MeterReading[] },
): { reading: number; source: string; period: string } | null {
  if (typeof manual === 'number' && Number.isFinite(manual)) {
    return { reading: manual, source: '抄录时带入', period: previousMonth(period) }
  }
  const archives = sourceRows?.archives ?? table<MeterArchiveEntry>(T_ARCHIVE)
  const archiveHits = archives
    .filter((row) => row.pointCode === pointCode && row.period < period)
    .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : b.version - a.version))
  if (archiveHits.length) {
    const hit = archiveHits[0]
    return { reading: hit.reading, source: `上期归档 v${hit.version}（${hit.period}）`, period: hit.period }
  }
  const reads = sourceRows?.reads ?? table<MeterReading>(T_READ)
  const legacyHits = reads
    .filter((row) => row.pointCode === pointCode && row.period < period && row.status === '已确认')
    .sort((a, b) => (a.period < b.period ? 1 : -1))
  if (legacyHits.length) {
    return { reading: legacyHits[0].currentReading, source: `老抄表单兼容取数（${legacyHits[0].period}）`, period: legacyHits[0].period }
  }
  return null
}

// ── 主表同步：列表/详情/导出看到的本期、上期、电量与抄表记录一致 ───────────────

function syncMasterInDraft(draft: Draft, pointCode: string): void {
  const masters = draftTable<EntryRow>(draft, T_MASTER)
  const index = masters.findIndex((row) => String(row['计量点编号']) === pointCode)
  if (index < 0) {
    return
  }
  const point = toPoint(masters[index])
  const reads = draftTable<MeterReading>(draft, T_READ)
    .filter((row) => row.pointCode === pointCode)
    .sort((a, b) => (a.period < b.period ? 1 : -1))
  const latest = reads[0]
  const previous = latest
    ? resolvePrevious(pointCode, latest.period, undefined, {
        archives: draftTable<MeterArchiveEntry>(draft, T_ARCHIVE),
        reads,
      })
    : null
  masters[index] = toMasterRow(
    { ...point, status: latest ? latest.status : '待抄表' },
    latest
      ? {
          '结算周期': latest.period,
          '抄表日期': latest.readDate,
          '本期读数': latest.currentReading,
          '上期读数': previous ? previous.reading : '',
          '本期电量': latest.energy,
          '计量状态': latest.status,
          status: latest.status,
          pending: latest.status !== '已确认',
          abnormal: latest.status === '已驳回',
        }
      : {
          '结算周期': '',
          '抄表日期': '',
          '本期读数': '',
          '上期读数': previous ? previous.reading : '',
          '本期电量': '',
          '计量状态': '待抄表',
          status: '待抄表',
          pending: true,
          abnormal: false,
        },
  )
}

// ── 权限：抄录限本电站人员；改倍率限本电站计量专责 ───────────────────────────

function ensureStation(point: MeterPoint, operator: OperatorProfile, action: string): string | null {
  if (operator.role === '值班管理员') {
    return null
  }
  if (operator.stationCode && operator.stationCode !== point.stationCode) {
    return `${action}被拒绝：${operator.name} 隶属 ${operator.stationName || '其他电站'}，不是 ${point.stationName} 的人员`
  }
  return null
}

function ensureRatioRole(point: MeterPoint, operator: OperatorProfile): string | null {
  if (operator.role !== '计量专责') {
    return `倍率变更被拒绝：只有本电站的计量专责可改，${operator.name} 当前岗位是「${operator.role}」`
  }
  if (operator.stationCode !== point.stationCode) {
    return `倍率变更被拒绝：${operator.name} 不是 ${point.stationName} 的计量专责，跨站不能改`
  }
  return null
}

// ── 表计取数：取不到数重取而不是清零 ─────────────────────────────────────────

// 演示默认取数通道稳定；失败重取路径由测试注入故障驱动验证
let dialFailureRate = 0
let dialAttempts = 0

/** 供演示/测试替换取数通道：返回表底，或抛错表示通讯失败 */
let dialDriver: (() => number) | null = null

export function setMeterDialDriver(driver: (() => number) | null): void {
  dialDriver = driver
}

export function setMeterDialFailureRate(rate: number): void {
  dialFailureRate = Math.min(1, Math.max(0, rate))
}

export function getDialAttempts(): number {
  return dialAttempts
}

export function resetDialAttempts(): void {
  dialAttempts = 0
}

function dialOnce(): number {
  if (dialDriver) {
    return dialDriver()
  }
  dialAttempts += 1
  if (Math.random() < dialFailureRate) {
    throw new Error('表计通讯超时')
  }
  return Number((Math.random() * 500 + 1500).toFixed(2))
}

const RETRY_WAIT_MS = 120

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 自动重取，最多 3 次；全失败把最后一次错误抛出，调用方不得把读数清零 */
export async function fetchMeterReading(pointCode: string, maxRetries = 3): Promise<ServiceResult<{ reading: number; attempts: number }>> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const reading = dialOnce()
      return { ok: true, message: `${pointCode} 第 ${attempt} 次取数成功`, data: { reading, attempts: attempt } }
    } catch (error) {
      lastError = error
      if (attempt < maxRetries) {
        await wait(RETRY_WAIT_MS)
      }
    }
  }
  return {
    ok: false,
    message: `${pointCode} 连续 ${maxRetries} 次取不到数（${lastError instanceof Error ? lastError.message : '通讯失败'}），原有读数保留未清零，请稍后重取`,
  }
}

// ── 抄录：本期读数、上期读数、计量状态一笔落定，失败整笔退回 ──────────────────

export function submitReading(input: CaptureInput): ServiceResult<MeterReading> {
  const point = getPoint(input.pointCode)
  if (!point) {
    return { ok: false, message: `计量点 ${input.pointCode} 不存在` }
  }
  const denied = ensureStation(point, input.operator, '抄录')
  if (denied) {
    return { ok: false, message: denied }
  }
  if (!/^\d{4}-\d{2}$/.test(input.period)) {
    return { ok: false, message: '结算周期必须是 YYYY-MM 格式' }
  }
  if (!isDate(input.readDate)) {
    return { ok: false, message: '抄表日期必须是 YYYY-MM-DD 的合法日期' }
  }
  if (periodOf(input.readDate) !== input.period) {
    return { ok: false, message: `抄表日期 ${input.readDate} 不属于结算周期 ${input.period}` }
  }
  if (!Number.isFinite(input.currentReading) || input.currentReading < 0) {
    return { ok: false, message: '本期读数必须是不小于 0 的数字' }
  }
  if (input.manualPrevious !== undefined) {
    if (!Number.isFinite(input.manualPrevious) || input.manualPrevious < 0) {
      return { ok: false, message: '手工上期读数必须是不小于 0 的数字' }
    }
    if (input.currentReading < input.manualPrevious) {
      return { ok: false, message: `本期读数 ${input.currentReading} 小于手工上期读数 ${input.manualPrevious}` }
    }
  }

  try {
    return withTransaction((draft) => {
      const reads = draftTable<MeterReading>(draft, T_READ)
      const existing = findReading(reads, input.pointCode, input.period)
      const token = input.requestToken || makeToken([input.pointCode, input.period])
      if (existing) {
        // 幂等：同令牌重复提交抄录只算一次，原样返回
        if (input.requestToken && existing.requestToken === input.requestToken) {
          return {
            ok: true,
            message: `该抄录已落账（${input.pointCode} ${input.period}），重复提交只算一次`,
            data: clone(existing),
          }
        }
        if (existing.status !== '已驳回') {
          return {
            ok: false,
            message: `${input.pointCode} ${input.period} 已有${existing.status}抄表记录，同一计量点同一周期只允许一笔；如需更正请先驳回复核后重抄`,
          }
        }
        // 被驳回的那笔重抄：沿用原编号，保证复核、结算仍指向同一笔
        const ratioHit = ratioFor(input.pointCode, input.period, draft)
        if (!ratioHit) {
          return { ok: false, message: `${input.pointCode} 在 ${input.period} 前没有生效倍率，倍率需从投运时间补起` }
        }
        const previous = resolvePrevious(input.pointCode, input.period, input.manualPrevious, {
          archives: draftTable<MeterArchiveEntry>(draft, T_ARCHIVE),
          reads,
        })
        if (!previous) {
          return { ok: false, message: `${input.pointCode} 在 ${input.period} 之前没有任何归档或老抄表上期读数，请手工录入上期读数` }
        }
        if (input.currentReading < previous.reading) {
          return { ok: false, message: `本期读数 ${input.currentReading} 小于上期读数 ${previous.reading}，疑似抄录错误，请核对倍率或表底` }
        }
        const energy = roundEnergy(input.currentReading - previous.reading, ratioHit.ratio)
        const revised: MeterReading = {
          ...existing,
          readDate: input.readDate,
          currentReading: input.currentReading,
          previousReading: previous.reading,
          ratio: ratioHit.ratio,
          energy,
          status: '已抄录',
          requestToken: token,
          operator: input.operator.name,
          rejectReason: undefined,
          createdAt: Date.now(),
          confirmedAt: undefined,
          reviewer: undefined,
        }
        const index = reads.findIndex((row) => row.id === existing.id)
        reads[index] = revised as unknown as MeterReading
        syncMasterInDraft(draft, input.pointCode)
        return { ok: true, message: `${input.pointCode} 重抄落定，本期电量 ${energy} kWh`, data: clone(revised) }
      }

      const ratioHit = ratioFor(input.pointCode, input.period, draft)
      if (!ratioHit) {
        return { ok: false, message: `${input.pointCode} 在 ${input.period} 前没有生效倍率，倍率需从投运时间补起` }
      }
      const previous = resolvePrevious(input.pointCode, input.period, input.manualPrevious, {
        archives: draftTable<MeterArchiveEntry>(draft, T_ARCHIVE),
        reads,
      })
      if (!previous) {
        return { ok: false, message: `${input.pointCode} 在 ${input.period} 之前没有任何归档或老抄表上期读数，请手工录入上期读数` }
      }
      if (input.currentReading < previous.reading) {
        return { ok: false, message: `本期读数 ${input.currentReading} 小于上期读数 ${previous.reading}，疑似抄录错误，请核对倍率或表底` }
      }
      const energy = roundEnergy(input.currentReading - previous.reading, ratioHit.ratio)
      const record: MeterReading = {
        id: nextId(reads),
        pointCode: input.pointCode,
        stationCode: point.stationCode,
        period: input.period,
        readDate: input.readDate,
        currentReading: input.currentReading,
        previousReading: previous.reading,
        ratio: ratioHit.ratio,
        energy,
        status: '已抄录',
        requestToken: token,
        operator: input.operator.name,
        createdAt: Date.now(),
      }
      reads.push(record as unknown as MeterReading)
      syncMasterInDraft(draft, input.pointCode)
      return { ok: true, message: `${input.pointCode} 抄录一次落定，本期电量 ${energy} kWh`, data: clone(record) }
    })
  } catch (error) {
    return { ok: false, message: `抄录整笔退回：${error instanceof Error ? error.message : '写入失败'}` }
  }
}

// ── 复核流转 ──────────────────────────────────────────────────────────────────

export function submitForReview(input: ReviewInput): ServiceResult {
  const point = getPoint(input.pointCode)
  if (!point) {
    return { ok: false, message: `计量点 ${input.pointCode} 不存在` }
  }
  const denied = ensureStation(point, input.operator, '提交复核')
  if (denied) {
    return { ok: false, message: denied }
  }
  try {
    return withTransaction((draft) => {
      const reads = draftTable<MeterReading>(draft, T_READ)
      const record = findReading(reads, input.pointCode, input.period)
      if (!record) {
        return { ok: false, message: `${input.pointCode} ${input.period} 还没有抄表记录` }
      }
      if (record.status !== '已抄录' && record.status !== '已驳回') {
        return { ok: false, message: `当前状态是「${record.status}」，只有已抄录的读数能提交复核` }
      }
      record.status = '待复核'
      record.rejectReason = undefined
      syncMasterInDraft(draft, input.pointCode)
      return { ok: true, message: `${input.pointCode} ${input.period} 已提交复核` }
    })
  } catch (error) {
    return { ok: false, message: `提交失败，整笔退回：${error instanceof Error ? error.message : '写入失败'}` }
  }
}

/** 复核确认：上期读数追加归档（不覆盖旧版），结果落发电结算待核算清单 */
export function confirmReading(input: ReviewInput): ServiceResult {
  const point = getPoint(input.pointCode)
  if (!point) {
    return { ok: false, message: `计量点 ${input.pointCode} 不存在` }
  }
  const denied = ensureStation(point, input.operator, '复核确认')
  if (denied) {
    return { ok: false, message: denied }
  }
  try {
    return withTransaction((draft) => {
      const reads = draftTable<MeterReading>(draft, T_READ)
      const record = findReading(reads, input.pointCode, input.period)
      if (!record) {
        return { ok: false, message: `${input.pointCode} ${input.period} 还没有抄表记录` }
      }
      if (record.status !== '待复核') {
        return { ok: false, message: `当前状态是「${record.status}」，只有待复核的读数能确认` }
      }
      record.status = '已确认'
      record.confirmedAt = Date.now()
      record.reviewer = input.operator.name

      // 归档只追加：同周期已有版本时 version + 1，旧版保留不覆盖
      const archives = draftTable<MeterArchiveEntry>(draft, T_ARCHIVE)
      const versions = archives.filter((row) => row.pointCode === input.pointCode && row.period === input.period)
      archives.push({
        id: nextId(archives),
        pointCode: input.pointCode,
        period: input.period,
        reading: record.currentReading,
        ratio: record.ratio,
        energy: record.energy,
        version: versions.length + 1,
        source: '复核确认',
        readingId: record.id,
        archivedAt: Date.now(),
      } as unknown as MeterArchiveEntry)

      // 待核算清单按「计量点+周期」幂等；驳回后重新确认时复用同一条，电量两边恒等
      const items = draftTable<SettlementItem>(draft, T_SETTLE)
      const existingItem = items.find((row) => row.pointCode === input.pointCode && row.period === input.period)
      if (existingItem) {
        existingItem.energy = record.energy
        existingItem.readingId = record.id
        existingItem.status = '待核算'
        existingItem.confirmedAt = Date.now()
        existingItem.readingRequestToken = record.requestToken
      } else {
        items.push({
          id: nextId(items),
          itemNo: makeItemNo(items, input.period),
          pointCode: input.pointCode,
          stationCode: point.stationCode,
          period: input.period,
          energy: record.energy,
          readingId: record.id,
          status: '待核算',
          confirmedAt: Date.now(),
          readingRequestToken: record.requestToken,
        } as unknown as SettlementItem)
      }

      syncMasterInDraft(draft, input.pointCode)
      return { ok: true, message: `复核已确认：${input.pointCode} 本期电量 ${record.energy} kWh 已归档并进入待核算清单` }
    })
  } catch (error) {
    return { ok: false, message: `确认失败，整笔退回：${error instanceof Error ? error.message : '写入失败'}` }
  }
}

function makeItemNo(items: SettlementItem[], period: string): string {
  const seq = items.filter((row) => row.period === period).length + 1
  return `WAIT-${period}-${String(seq).padStart(4, '0')}`
}

export function rejectReading(input: ReviewInput): ServiceResult {
  const point = getPoint(input.pointCode)
  if (!point) {
    return { ok: false, message: `计量点 ${input.pointCode} 不存在` }
  }
  if (!input.reason || !input.reason.trim()) {
    return { ok: false, message: '驳回复核必须填写原因' }
  }
  const denied = ensureStation(point, input.operator, '驳回复核')
  if (denied) {
    return { ok: false, message: denied }
  }
  try {
    return withTransaction((draft) => {
      const reads = draftTable<MeterReading>(draft, T_READ)
      const record = findReading(reads, input.pointCode, input.period)
      if (!record) {
        return { ok: false, message: `${input.pointCode} ${input.period} 还没有抄表记录` }
      }
      if (record.status !== '待复核') {
        return { ok: false, message: `当前状态是「${record.status}」，只有待复核的读数能驳回` }
      }
      record.status = '已驳回'
      record.rejectReason = input.reason!.trim()
      // 驳回后待核算项软移除；重新确认时同一计量点+周期的清单项会被复用
      const items = draftTable<SettlementItem>(draft, T_SETTLE)
      for (const item of items) {
        if (item.pointCode === input.pointCode && item.period === input.period && item.readingRequestToken === record.requestToken) {
          item.status = '已移除'
        }
      }
      syncMasterInDraft(draft, input.pointCode)
      return { ok: true, message: `${input.pointCode} ${input.period} 已驳回：${record.rejectReason}，可重抄后再提交` }
    })
  } catch (error) {
    return { ok: false, message: `驳回失败，整笔退回：${error instanceof Error ? error.message : '写入失败'}` }
  }
}

// ── 倍率：仅本电站计量专责；写入前校验；改后重算未确认电量；从投运日补版本 ─────

export function changeRatio(input: RatioInput): ServiceResult {
  const point = getPoint(input.pointCode)
  if (!point) {
    return { ok: false, message: `计量点 ${input.pointCode} 不存在` }
  }
  const denied = ensureRatioRole(point, input.operator)
  if (denied) {
    return { ok: false, message: denied }
  }
  if (!Number.isFinite(input.ratio) || input.ratio <= 0) {
    return { ok: false, message: '倍率必须是大于 0 的数字' }
  }
  if (!isDate(input.effectiveDate)) {
    return { ok: false, message: '生效日期必须是 YYYY-MM-DD 的合法日期' }
  }
  if (input.effectiveDate < point.commissioningDate) {
    return { ok: false, message: `生效日期不能早于投运日期 ${point.commissioningDate}；初始倍率已从投运时间补起` }
  }
  if (!input.reason.trim()) {
    return { ok: false, message: '变更倍率必须填写原因' }
  }
  try {
    return withTransaction((draft) => {
      const ratios = draftTable<MeterRatioChange>(draft, T_RATIO)
      const sameDay = ratios.find((row) => row.pointCode === input.pointCode && row.effectiveDate === input.effectiveDate)
      if (sameDay) {
        return { ok: false, message: `${input.pointCode} 在 ${input.effectiveDate} 已有倍率版本 ${sameDay.ratio}，同一天不能登记两个版本` }
      }
      ratios.push({
        id: nextId(ratios),
        pointCode: input.pointCode,
        ratio: input.ratio,
        effectiveDate: input.effectiveDate,
        reason: input.reason.trim(),
        operator: input.operator.name,
        changedAt: Date.now(),
      } as unknown as MeterRatioChange)

      // 重算该生效日之后、尚未确认的抄表电量；已确认/已归档的冻结不动
      const reads = draftTable<MeterReading>(draft, T_READ)
      const recalculated: string[] = []
      for (const reading of reads) {
        if (reading.pointCode !== input.pointCode) {
          continue
        }
        if (endOfPeriod(reading.period) < input.effectiveDate || reading.status === '已确认') {
          continue
        }
        const ratioAtPeriod = ratios
          .filter((row) => row.pointCode === input.pointCode && row.effectiveDate <= endOfPeriod(reading.period))
          .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1))[0]
        if (!ratioAtPeriod) {
          continue
        }
        reading.ratio = ratioAtPeriod.ratio
        reading.energy = roundEnergy(reading.currentReading - reading.previousReading, ratioAtPeriod.ratio)
        recalculated.push(`${reading.period}=${reading.energy}`)
      }

      // 待核算清单里未确认读数关联项不会存在（确认时才落清单）；此处防御性同步同点同期活项
      const items = draftTable<SettlementItem>(draft, T_SETTLE)
      for (const item of items) {
        if (item.pointCode === input.pointCode && item.status === '待核算') {
          const linked = reads.find((row) => row.id === item.readingId)
          if (linked && linked.status !== '已确认') {
            item.energy = linked.energy
          }
        }
      }

      // 主表当前倍率刷新
      const masters = draftTable<EntryRow>(draft, T_MASTER)
      const masterIndex = masters.findIndex((row) => String(row['计量点编号']) === input.pointCode)
      if (masterIndex >= 0) {
        const latestRatio = ratios
          .filter((row) => row.pointCode === input.pointCode)
          .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1))[0]
        masters[masterIndex] = { ...masters[masterIndex], '倍率': latestRatio ? latestRatio.ratio : input.ratio }
      }
      syncMasterInDraft(draft, input.pointCode)
      return {
        ok: true,
        message: recalculated.length
          ? `倍率已登记为 ${input.ratio}（${input.effectiveDate} 起），未确认电量已重算：${recalculated.join('，')} kWh`
          : `倍率已登记为 ${input.ratio}（${input.effectiveDate} 起）；没有需要重算的未确认抄表记录，历史归档不变`,
      }
    })
  } catch (error) {
    return { ok: false, message: `倍率变更失败，整笔退回：${error instanceof Error ? error.message : '写入失败'}` }
  }
}

// ── 批量灌档：先全量校验点名到行，全部通过才整笔写入；重复批次只认第一次 ────────

export type ImportError = { row: number; pointCode: string; message: string }

export type ImportReport = { total: number; accepted: number; errors: ImportError[] }

const IMPORT_HEADER = '计量点编号,结算周期,抄表日期,本期读数,倍率,上期读数(留空自动取归档)'

export function importTemplate(): { filename: string; content: string } {
  return {
    filename: '历史抄表导入模板.csv',
    content: `﻿${IMPORT_HEADER}\nMETE-0001,2026-07,2026-07-31,2090.40,1000,\n`,
  }
}

export function importHistoricalReadings(content: string, operator: OperatorProfile): ServiceResult<ImportReport> {
  const lines = content
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (!lines.length) {
    return { ok: false, message: '导入文件没有任何数据行', data: { total: 0, accepted: 0, errors: [] } }
  }
  const hasHeader = lines[0].startsWith('计量点编号')
  const dataLines = hasHeader ? lines.slice(1) : lines
  if (!dataLines.length) {
    return { ok: false, message: '导入文件只有表头，没有数据行', data: { total: 0, accepted: 0, errors: [] } }
  }

  // 同内容重复批次：幂等优先，只认第一次（即使首次之后状态已变，也不重放）
  const contentHash = hashText(content)
  const existed = table<MeterImportBatch>(T_IMPORT).find((item) => item.token === contentHash)
  if (existed) {
    return {
      ok: true,
      message: `该批次已于 ${new Date(existed.importedAt).toLocaleString()} 导入 ${existed.total} 行，重复提交只算一次`,
      data: { total: existed.total, accepted: 0, errors: [] },
    }
  }

  type ParsedRow = {
    lineNo: number
    pointCode: string
    period: string
    readDate: string
    currentReading: number
    ratio: number
    previousReadingText: string
  }
  const parsed: ParsedRow[] = []
  const errors: ImportError[] = []
  const seen = new Set<string>()

  dataLines.forEach((line, index) => {
    const lineNo = (hasHeader ? 2 : 1) + index
    const cells = line.split(',').map((cell) => cell.trim())
    const pointCode = cells[0] ?? ''
    const fail = (message: string) => errors.push({ row: lineNo, pointCode: pointCode || `第${lineNo}行`, message })
    if (cells.length < 5) {
      fail('列数不足，应为：计量点编号,结算周期,抄表日期,本期读数,倍率[,上期读数]')
      return
    }
    const [, period, readDate, currentText, ratioText, previousText = ''] = cells
    const point = getPoint(pointCode)
    if (!point) {
      fail(`计量点 ${pointCode} 不存在，缺这个计量点无法落账`)
      return
    }
    const denied = ensureStation(point, operator, '批量灌档')
    if (denied) {
      fail(denied)
      return
    }
    if (!/^\d{4}-\d{2}$/.test(period)) {
      fail('结算周期不是 YYYY-MM 格式')
      return
    }
    if (!isDate(readDate) || periodOf(readDate) !== period) {
      fail(`抄表日期 ${readDate} 缺失或不属于周期 ${period}`)
      return
    }
    const currentReading = Number(currentText)
    if (!Number.isFinite(currentReading) || currentReading < 0) {
      fail(`本期读数「${currentText}」不是合法的非负数字`)
      return
    }
    const ratio = Number(ratioText)
    if (!Number.isFinite(ratio) || ratio <= 0) {
      fail(`倍率「${ratioText}」必须是大于 0 的数字`)
      return
    }
    if (previousText !== '') {
      const previous = Number(previousText)
      if (!Number.isFinite(previous) || previous < 0) {
        fail(`上期读数「${previousText}」不是合法的非负数字`)
        return
      }
      if (currentReading < previous) {
        fail(`本期读数 ${currentReading} 小于上期读数 ${previous}`)
        return
      }
    }
    const key = `${pointCode}|${period}`
    if (seen.has(key)) {
      fail(`文件内计量点 ${pointCode} 的 ${period} 重复出现，一行以上无法确定哪笔算数`)
      return
    }
    const confirmed = table<MeterReading>(T_READ).find((row) => row.pointCode === pointCode && row.period === period && row.status === '已确认')
    if (confirmed) {
      fail(`计量点 ${pointCode} 的 ${period} 已有确认抄表记录，历史灌档不得覆盖`)
      return
    }
    seen.add(key)
    parsed.push({ lineNo, pointCode, period, readDate, currentReading, ratio, previousReadingText: previousText })
  })

  if (errors.length) {
    return {
      ok: false,
      message: `校验未通过，整批 ${dataLines.length} 行全部退回、一行未写；问题点名到行见明细`,
      data: { total: dataLines.length, accepted: 0, errors },
    }
  }

  // 第二轮：上期读数可解析校验。按计量点+周期排序，本批先落的行可作为后一行的上期；
  // 既无归档/老单、文件也没给上期值的，点名到行，整批退回。
  const simulated = new Map<string, number>()
  for (const row of [...parsed].sort((a, b) =>
    a.pointCode < b.pointCode ? -1 : a.pointCode > b.pointCode ? 1 : a.period < b.period ? -1 : 1,
  )) {
    const manual = row.previousReadingText === '' ? undefined : Number(row.previousReadingText)
    const previous = resolvePrevious(row.pointCode, row.period, manual)
    if (previous) {
      simulated.set(`${row.pointCode}|${row.period}`, row.currentReading)
      continue
    }
    // 本批里更早日历月的行：找紧邻的上一个月
    const earlier = [...simulated.entries()]
      .filter(([key]) => key.startsWith(`${row.pointCode}|`) && key.split('|')[1] < row.period)
      .sort(([ka], [kb]) => (ka < kb ? 1 : -1))[0]
    if (earlier) {
      simulated.set(`${row.pointCode}|${row.period}`, row.currentReading)
      continue
    }
    errors.push({
      row: row.lineNo,
      pointCode: row.pointCode,
      message: `计量点 ${row.pointCode} 的 ${previousMonth(row.period)} 没有上期读数：归档、老抄表单都取不到，请在该行补上上期读数`,
    })
  }

  if (errors.length) {
    return {
      ok: false,
      message: `校验未通过，整批 ${dataLines.length} 行全部退回、一行未写；问题点名到行见明细`,
      data: { total: dataLines.length, accepted: 0, errors: errors.sort((a, b) => a.row - b.row) },
    }
  }

  // 同内容重复批次的幂等检查已在解析前完成

  try {
    return withTransaction((draft) => {
      const reads = draftTable<MeterReading>(draft, T_READ)
      const archives = draftTable<MeterArchiveEntry>(draft, T_ARCHIVE)
      const ratios = draftTable<MeterRatioChange>(draft, T_RATIO)
      const imports = draftTable<MeterImportBatch>(draft, T_IMPORT)
      const touchedPoints = new Set<string>()

      for (const row of parsed) {
        const manual = row.previousReadingText === '' ? undefined : Number(row.previousReadingText)
        // 文件内顺序不定：上期先找已落库的，再找本批刚写进去的
        const previous =
          resolvePrevious(row.pointCode, row.period, manual, { archives, reads }) ??
          (manual === undefined ? null : { reading: manual, source: '文件提供', period: previousMonth(row.period) })
        if (!previous) {
          // 理论上前置校验已覆盖，兜住事务一致性
          throw new Error(`第 ${row.lineNo} 行 ${row.pointCode} 取不到上期读数`)
        }
        const energy = roundEnergy(row.currentReading - previous.reading, row.ratio)
        const token = makeToken(['import', row.pointCode, row.period])
        const record: MeterReading = {
          id: nextId(reads),
          pointCode: row.pointCode,
          stationCode: getPoint(row.pointCode)!.stationCode,
          period: row.period,
          readDate: row.readDate,
          currentReading: row.currentReading,
          previousReading: previous.reading,
          ratio: row.ratio,
          energy,
          status: '已确认',
          requestToken: token,
          operator: operator.name,
          createdAt: Date.now(),
          confirmedAt: Date.now(),
          reviewer: operator.name,
        }
        reads.push(record as unknown as MeterReading)
        const versions = archives.filter((item) => item.pointCode === row.pointCode && item.period === row.period)
        archives.push({
          id: nextId(archives),
          pointCode: row.pointCode,
          period: row.period,
          reading: row.currentReading,
          ratio: row.ratio,
          energy,
          version: versions.length + 1,
          source: '批量灌档',
          readingId: record.id,
          archivedAt: Date.now(),
        } as unknown as MeterArchiveEntry)
        // 倍率历史从投运日补起：文件给了倍率但没有历史版本时，补一条投运初版与本文件版本
        const point = getPoint(row.pointCode)!
        if (!ratios.some((item) => item.pointCode === row.pointCode)) {
          ratios.push({
            id: nextId(ratios),
            pointCode: row.pointCode,
            ratio: row.ratio,
            effectiveDate: point.commissioningDate,
            reason: '批量灌档补登初始倍率',
            operator: operator.name,
            changedAt: Date.now(),
          } as unknown as MeterRatioChange)
        }
        touchedPoints.add(row.pointCode)
      }

      imports.push({
        id: nextId(imports),
        token: contentHash,
        total: parsed.length,
        importedAt: Date.now(),
        operator: operator.name,
        contentHash,
      } as unknown as MeterImportBatch)

      for (const pointCode of touchedPoints) {
        syncMasterInDraft(draft, pointCode)
      }
      return {
        ok: true,
        message: `批量灌档成功：${parsed.length} 行一次性落定并归档，缺行/错行为 0`,
        data: { total: dataLines.length, accepted: parsed.length, errors: [] },
      }
    })
  } catch (error) {
    return {
      ok: false,
      message: `灌档写入失败，整批退回：${error instanceof Error ? error.message : '写入失败'}`,
      data: { total: dataLines.length, accepted: 0, errors },
    }
  }
}

// ── 单据：详情面板、下载文件、打印队列共用同一份内容 ───────────────────────────

export function buildMeterDocument(pointCode: string, period?: string): MeterDetail | null {
  const point = getPoint(pointCode)
  if (!point) {
    return null
  }
  const targetPeriod = period ?? latestPeriod(pointCode)
  const reading = table<MeterReading>(T_READ).find((row) => row.pointCode === pointCode && row.period === targetPeriod) ?? null
  const previous = resolvePrevious(pointCode, targetPeriod)
  return {
    point,
    reading,
    previous,
    archives: table<MeterArchiveEntry>(T_ARCHIVE)
      .filter((row) => row.pointCode === pointCode)
      .sort((a, b) => (a.period < b.period ? 1 : a.version < b.version ? 1 : -1)),
    ratios: table<MeterRatioChange>(T_RATIO)
      .filter((row) => row.pointCode === pointCode)
      .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1)),
    settlementItems: table<SettlementItem>(T_SETTLE)
      .filter((row) => row.pointCode === pointCode)
      .sort((a, b) => (a.period < b.period ? 1 : -1)),
  }
}

/** 单据逐行序列化：面板展示、CSV 下载、打印送出走的都是这里，保证三份内容一致 */
export function serializeMeterDocument(detail: MeterDetail): { filename: string; lines: string[]; hash: string } {
  const { point, reading, previous, archives, ratios, settlementItems } = detail
  const lines: string[] = []
  const push = (cells: (string | number)[]) => lines.push(cells.map(csvEscape).join(','))
  const pushBlank = () => lines.push('')

  push(['关口计量表抄录结算单'])
  push(['计量点编号', point.pointCode, '所属电站', point.stationName])
  push(['计量方向', point.direction, '表计型号', point.meterModel])
  push(['当前倍率', point.ratio, '投运日期', point.commissioningDate])
  pushBlank()

  push(['本期抄录'])
  if (reading) {
    push(['结算周期', reading.period])
    push(['抄表日期', reading.readDate])
    push(['本期读数', reading.currentReading])
    push(['上期读数', reading.previousReading, `来源：${previous?.source ?? '本笔落抄时带入'}`])
    push(['生效倍率', reading.ratio])
    push(['本期电量(kWh)', reading.energy])
    push(['计量状态', reading.status])
    push(['抄录人', reading.operator, '提交令牌', reading.requestToken])
    if (reading.rejectReason) {
      push(['驳回原因', reading.rejectReason])
    }
  } else {
    push(['本期尚无抄表记录'])
  }
  pushBlank()

  push(['上期读数归档（只追加不覆盖）'])
  push(['周期', '表底', '倍率', '电量(kWh)', '版本', '来源', '归档时间'])
  for (const archive of archives) {
    push([archive.period, archive.reading, archive.ratio, archive.energy, `v${archive.version}`, archive.source, new Date(archive.archivedAt).toLocaleString()])
  }
  pushBlank()

  push(['倍率版本'])
  push(['生效日期', '倍率', '原因', '操作人'])
  for (const ratio of ratios) {
    push([ratio.effectiveDate, ratio.ratio, ratio.reason, ratio.operator])
  }
  pushBlank()

  push(['发电结算待核算清单'])
  push(['清单项编号', '周期', '本期电量(kWh)', '状态', '与抄表记录一致'])
  for (const item of settlementItems) {
    const linked = table<MeterReading>(T_READ).find((row) => row.id === item.readingId)
    const matched = linked ? (linked.energy === item.energy ? '一致' : '不一致') : '无关联抄表'
    push([item.itemNo, item.period, item.energy, item.status, matched])
  }

  return {
    filename: `关口计量表单据-${point.pointCode}-${reading?.period ?? '未抄表'}.csv`,
    lines,
    hash: hashText(lines.join('\n')),
  }
}

export function exportMeterDocument(pointCode: string, period?: string): { filename: string; content: string; hash: string } | null {
  const detail = buildMeterDocument(pointCode, period)
  if (!detail) {
    return null
  }
  const { filename, lines, hash } = serializeMeterDocument(detail)
  return { filename, content: `﻿${lines.join('\n')}`, hash }
}

// ── 打印队列：逐行送出、逐行落断点，中断从断点续打，不留半包 ──────────────────

let printDriver: ((line: string) => boolean) | null = null

/** 替换打印驱动：返回 false 表示本行送出失败（模拟卡纸/断连） */
export function setPrintDriver(driver: ((line: string) => boolean) | null): void {
  printDriver = driver
}

const abortRequested = new Set<number>()

export function requestAbortPrint(jobId: number): void {
  abortRequested.add(jobId)
}

export function createPrintJob(pointCode: string, operator: OperatorProfile): ServiceResult<PrintJob> {
  const detail = buildMeterDocument(pointCode)
  if (!detail) {
    return { ok: false, message: `计量点 ${pointCode} 不存在` }
  }
  const denied = ensureStation(detail.point, operator, '打印单据')
  if (denied) {
    return { ok: false, message: denied }
  }
  const { lines, hash } = serializeMeterDocument(detail)
  try {
    return withTransaction((draft) => {
      const jobs = draftTable<PrintJob>(draft, T_PRINT)
      const seq = jobs.length + 1
      const job: PrintJob = {
        id: nextId(jobs),
        jobNo: `PRT-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`,
        pointCode,
        period: detail.reading?.period ?? '',
        contentHash: hash,
        content: lines,
        totalLines: lines.length,
        deliveredLines: 0,
        status: '进行中',
        driver: '关口表单据打印机',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      jobs.push(job as unknown as PrintJob)
      return { ok: true, message: `打印任务 ${job.jobNo} 已建立，共 ${job.totalLines} 行`, data: clone(job) }
    })
  } catch (error) {
    return { ok: false, message: `打印任务建立失败：${error instanceof Error ? error.message : '写入失败'}` }
  }
}

export function listPrintJobs(): PrintJob[] {
  return table<PrintJob>(T_PRINT).sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 从断点续打：只送 deliveredLines 之后的行；每行送出成功才推进断点并落盘。
 * 任一行失败/中断 → 任务置「已中断」，已送行不重打，再次调用从失败行续送。
 */
export function advancePrintJob(jobId: number, maxLines = 6): ServiceResult<PrintJob> {
  try {
    return withTransaction((draft) => {
      const jobs = draftTable<PrintJob>(draft, T_PRINT)
      const job = jobs.find((row) => row.id === jobId)
      if (!job) {
        return { ok: false, message: `打印任务 ${jobId} 不存在` }
      }
      if (job.status === '已打完') {
        return { ok: true, message: `${job.jobNo} 已打完，无需续打`, data: clone(job) }
      }
      let sent = 0
      for (let index = job.deliveredLines; index < job.totalLines && sent < maxLines; index += 1) {
        if (abortRequested.has(jobId)) {
          abortRequested.delete(jobId)
          job.status = '已中断'
          job.updatedAt = Date.now()
          return { ok: true, message: `${job.jobNo} 已在第 ${index + 1} 行前手动中断，可随时续打`, data: clone(job) }
        }
        const line = job.content[index]
        const delivered = printDriver ? printDriver(line) : true
        if (!delivered) {
          job.status = '已中断'
          job.updatedAt = Date.now()
          return {
            ok: false,
            message: `${job.jobNo} 第 ${index + 1} 行送出失败，断点保留在 ${job.deliveredLines}/${job.totalLines}，续打不会重打已送内容`,
            data: clone(job),
          }
        }
        job.deliveredLines = index + 1
        job.updatedAt = Date.now()
        sent += 1
      }
      if (job.deliveredLines >= job.totalLines) {
        job.status = '已打完'
        return { ok: true, message: `${job.jobNo} 全部 ${job.totalLines} 行打完`, data: clone(job) }
      }
      job.status = '进行中'
      return { ok: true, message: `${job.jobNo} 已送出 ${sent} 行，进度 ${job.deliveredLines}/${job.totalLines}`, data: clone(job) }
    })
  } catch (error) {
    return { ok: false, message: `打印推进失败，断点未动：${error instanceof Error ? error.message : '写入失败'}` }
  }
}

/** 续打前比对单据内容是否已变：变了给出提示但仍允许按冻结快照续完 */
export function printJobDrift(job: PrintJob): { drifted: boolean; currentHash: string } {
  const detail = buildMeterDocument(job.pointCode, job.period || undefined)
  if (!detail) {
    return { drifted: true, currentHash: '' }
  }
  const { hash } = serializeMeterDocument(detail)
  return { drifted: hash !== job.contentHash, currentHash: hash }
}

// ── 结算待核算清单与对账 ─────────────────────────────────────────────────────

export function listSettlementPending(period?: string, stationCode?: string): SettlementItem[] {
  return table<SettlementItem>(T_SETTLE)
    .filter((row) => row.status === '待核算')
    .filter((row) => (period ? row.period === period : true))
    .filter((row) => (stationCode ? row.stationCode === stationCode : true))
    .sort((a, b) => (a.period < b.period ? 1 : a.itemNo < b.itemNo ? 1 : -1))
}

/** 对账：待核算清单每一项的本期电量必须与关联抄表记录一致 */
export function reconcilePending(): { itemNo: string; pointCode: string; period: string; expected: number; actual: number }[] {
  const reads = table<MeterReading>(T_READ)
  const mismatches: ReturnType<typeof reconcilePending> = []
  for (const item of table<SettlementItem>(T_SETTLE)) {
    if (item.status !== '待核算') {
      continue
    }
    const linked = reads.find((row) => row.id === item.readingId)
    if (!linked || linked.energy !== item.energy) {
      mismatches.push({
        itemNo: item.itemNo,
        pointCode: item.pointCode,
        period: item.period,
        expected: linked ? linked.energy : 0,
        actual: item.energy,
      })
    }
  }
  return mismatches
}

// ── 计量领域整体重置（含全部领域表） ─────────────────────────────────────────

export function resetMeterDomain(): void {
  commitTables({
    [T_MASTER]: clone(SEED_ROWS[T_MASTER] ?? []),
    [T_READ]: clone(SEED_ROWS[T_READ] ?? []),
    [T_ARCHIVE]: clone(SEED_ROWS[T_ARCHIVE] ?? []),
    [T_RATIO]: clone(SEED_ROWS[T_RATIO] ?? []),
    [T_SETTLE]: clone(SEED_ROWS[T_SETTLE] ?? []),
    [T_IMPORT]: clone(SEED_ROWS[T_IMPORT] ?? []),
    [T_PRINT]: clone(SEED_ROWS[T_PRINT] ?? []),
  })
}
