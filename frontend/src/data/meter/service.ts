import {
  buildPanelSnapshot,
  computeEnergy,
  draftNoFor,
  dryRunImport,
  isValidDate,
  isValidPeriod,
  parseImportCsv,
  ratioOnDate,
  readingsOfMeter,
  recomputeOpenReadings,
  resolvePrevious,
  roundEnergy,
  serializeSnapshot,
  settlementDrafts,
  toChunks,
  validateRatio,
  assembleJob,
} from './engine'
import { REMOTE_READINGS } from './seed'
import { commit, listJobs, listMeterPoints, listReadings, nextReadingId } from './store'
import type {
  ExportJob,
  ImportResult,
  MeterPoint,
  MeterStatus,
  ReadingRecord,
  ReviewInput,
  RatioInput,
  SettlementDraft,
  SubmitReadingInput,
} from './types'

export type Actor = {
  name: string
  role: string
  stationId: string
}

export const METER_SPECIALIST_ROLE = '计量专责'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 演示用：打开后模拟采集链路故障，取数会连续失败，用来验证「重取而不是清零」。
let fetchFaultInjected = false
export function setFetchFaultInjection(on: boolean): void {
  fetchFaultInjected = on
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---------- 查询 ----------

export type MeterListItem = MeterPoint & {
  lastPeriod: string
  lastCurrent: number | null
  lastPrevious: number | null
  lastEnergy: number | null
  readingStatus: string
}

export function getMeterList(): MeterListItem[] {
  const meters = listMeterPoints()
  const readings = listReadings()
  return meters.map((meter) => {
    const latest = readingsOfMeter(readings, meter.id)[0]
    return {
      ...meter,
      lastPeriod: latest?.period ?? '—',
      lastCurrent: latest ? latest.current : null,
      lastPrevious: latest ? latest.previous : null,
      lastEnergy: latest ? latest.energy : null,
      readingStatus: latest?.status ?? '未抄录',
    }
  })
}

export function getMeterDetail(id: number): MeterPoint {
  const meter = listMeterPoints().find((item) => item.id === id)
  if (!meter) {
    throw new Error(`没有找到编号为 ${id} 的关口计量表`)
  }
  return meter
}

export function getReadings(meterId: number): ReadingRecord[] {
  return readingsOfMeter(listReadings(), meterId)
}

export function getAllReadings(): ReadingRecord[] {
  return [...listReadings()].sort((a, b) =>
    a.period.localeCompare(b.period) || a.meterId - b.meterId,
  )
}

export function getSettlementDrafts(): SettlementDraft[] {
  return settlementDrafts(listMeterPoints(), listReadings())
}

/** 详情面板导出/打印用：快照与页面展示同源同数据。 */
export function getDetailSnapshot(meterId: number) {
  const meter = getMeterDetail(meterId)
  const readings = listReadings()
  const drafts = new Set(settlementDrafts(listMeterPoints(), readings).flatMap((draft) => draft.readingIds))
  return buildPanelSnapshot(meter, readings, drafts)
}

// ---------- 抄录：一次落定 ----------

/**
 * 抄录提交。本期读数、上期读数、适用倍率、本期电量与计量状态在同一事务里落定：
 * - 同一令牌 / 同一计量点同一周期重复提交 → 幂等，只算一次；
 * - 已复核确认的期间已归档，拒绝覆盖；
 * - 校验不过（读数倒走、周期非法等）整笔退回，不留半截数据。
 */
export function submitReading(input: SubmitReadingInput): { ok: boolean; message: string; reading?: ReadingRecord; duplicated?: boolean } {
  if (!isValidPeriod(input.period)) {
    return { ok: false, message: `周期格式应为 YYYY-MM：${input.period}` }
  }
  if (!isValidDate(input.readDate)) {
    return { ok: false, message: `抄表日期格式应为 YYYY-MM-DD：${input.readDate}` }
  }
  if (typeof input.current !== 'number' || Number.isNaN(input.current) || input.current < 0) {
    return { ok: false, message: '本期读数必须是非负数字' }
  }

  const holder: { reading: ReadingRecord | null; duplicated: boolean } = { reading: null, duplicated: false }
  try {
    commit((draft) => {
      const index = draft.meters.findIndex((item) => item.id === input.meterId)
      if (index < 0) {
        throw new FlowError(`计量点 ${input.meterId} 不在册`)
      }
      const meter = draft.meters[index]

      const sameToken = draft.readings.find((item) => item.submitToken === input.token)
      if (sameToken) {
        holder.reading = sameToken
        holder.duplicated = true
        return
      }
      const existing = draft.readings.find(
        (item) => item.meterId === meter.id && item.period === input.period,
      )
      if (existing) {
        if (existing.status === '已确认') {
          throw new FlowError(`${meter.code} ${input.period} 已经复核归档，上期/本期读数不允许再覆盖`)
        }
        throw new FlowError(`${meter.code} ${input.period} 已抄录（${existing.status}），重复提交不重复计电量；如需改动请用「改录」`)
      }

      const previous = resolvePrevious(draft.readings, meter, input.period)
      if (!input.resetMeter && input.current < previous) {
        throw new FlowError(
          `本期读数 ${input.current} 小于上期读数 ${previous}，疑似抄错；换表倒行请勾选换表起算，否则整笔退回`,
        )
      }
      const ratio = ratioOnDate(meter, input.readDate)
      const ratioError = validateRatio(ratio)
      if (ratioError) {
        throw new FlowError(`适用倍率异常：${ratioError}`)
      }
      const energy = computeEnergy(input.current, previous, ratio, input.resetMeter)
      const record: ReadingRecord = {
        id: nextReadingId(draft.readings),
        meterId: meter.id,
        period: input.period,
        readDate: input.readDate,
        current: input.current,
        previous: input.resetMeter ? 0 : previous,
        ratio,
        energy,
        status: '已抄录',
        submittedAt: new Date().toISOString(),
        submittedBy: input.operator,
        submitToken: input.token,
        resetMeter: input.resetMeter,
      }
      draft.readings.push(record)
      holder.reading = record
      if (meter.status === '待抄表') {
        draft.meters[index] = { ...meter, status: '已抄录' as MeterStatus }
      }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '抄录失败，整笔退回' }
  }
  const committed = holder.reading
  if (!committed) {
    return { ok: false, message: '抄录未生效，整笔退回' }
  }
  return {
    ok: true,
    duplicated: holder.duplicated,
    reading: committed,
    message: holder.duplicated
      ? `该抄录已提交过，按首次提交结果返回，本期电量只算一次（${committed.energy} kWh）`
      : `抄录已落定：本期电量 ${committed.energy} kWh，状态「已抄录」`,
  }
}

/** 改录：仅「已抄录」（未提交复核 / 复核被驳回）期间允许；改完按当日倍率重算电量。 */
export function amendReading(
  readingId: number,
  patch: { current: number; readDate: string; operator: string; resetMeter?: boolean },
): { ok: boolean; message: string } {
  if (!isValidDate(patch.readDate)) {
    return { ok: false, message: `抄表日期格式应为 YYYY-MM-DD：${patch.readDate}` }
  }
  if (typeof patch.current !== 'number' || Number.isNaN(patch.current) || patch.current < 0) {
    return { ok: false, message: '本期读数必须是非负数字' }
  }
  try {
    commit((draft) => {
      const rIndex = draft.readings.findIndex((item) => item.id === readingId)
      if (rIndex < 0) {
        throw new FlowError(`没有找到抄录记录 ${readingId}`)
      }
      const record = draft.readings[rIndex]
      if (record.status === '已确认') {
        throw new FlowError('该期间已复核归档，不能改录')
      }
      if (record.status === '待复核') {
        throw new FlowError('该期间已在复核队列，请先由复核人驳回后再改录')
      }
      const meter = draft.meters.find((item) => item.id === record.meterId)
      if (!meter) {
        throw new FlowError('计量点不在册')
      }
      if (!patch.resetMeter && patch.current < record.previous) {
        throw new FlowError(`本期读数 ${patch.current} 小于上期读数 ${record.previous}，整笔退回`)
      }
      const ratio = ratioOnDate(meter, patch.readDate)
      draft.readings[rIndex] = {
        ...record,
        current: patch.current,
        previous: patch.resetMeter ? 0 : record.previous,
        resetMeter: patch.resetMeter,
        readDate: patch.readDate,
        ratio,
        energy: computeEnergy(patch.current, record.previous, ratio, patch.resetMeter),
        submittedBy: patch.operator,
      }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '改录失败，整笔退回' }
  }
  return { ok: true, message: '改录已落定，本期电量已按当日适用倍率重算' }
}

export function sendForReview(readingId: number, actor: Actor): { ok: boolean; message: string } {
  try {
    commit((draft) => {
      const rIndex = draft.readings.findIndex((item) => item.id === readingId)
      if (rIndex < 0) {
        throw new FlowError(`没有找到抄录记录 ${readingId}`)
      }
      const record = draft.readings[rIndex]
      if (record.status !== '已抄录') {
        throw new FlowError(`当前状态「${record.status}」不能提交复核`)
      }
      draft.readings[rIndex] = { ...record, status: '待复核' }
      const mIndex = draft.meters.findIndex((item) => item.id === record.meterId)
      if (mIndex >= 0) {
        draft.meters[mIndex] = { ...draft.meters[mIndex], status: '待复核' }
      }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '提交复核失败' }
  }
  return { ok: true, message: '已提交复核' }
}

/**
 * 复核：
 * - 通过 → 状态「已确认」并把本期读数固化为归档值（后续任何抄录都不许覆盖），
 *   同站同周期的上网关口记录汇总进发电结算「待核算清单」，结算单电量取自记录本身，两处必然对得上；
 * - 驳回 → 回到「已抄录」，允许改录后重新提交。
 */
export function reviewReading(input: ReviewInput, actor: Actor): { ok: boolean; message: string } {
  try {
    commit((draft) => {
      const rIndex = draft.readings.findIndex((item) => item.id === input.readingId)
      if (rIndex < 0) {
        throw new FlowError(`没有找到抄录记录 ${input.readingId}`)
      }
      const record = draft.readings[rIndex]
      if (record.status !== '待复核') {
        throw new FlowError(`当前状态「${record.status}」，只有待复核记录能出复核结论`)
      }
      if (input.pass) {
        const meter = draft.meters.find((item) => item.id === record.meterId)
        if (!meter) {
          throw new FlowError('计量点不在册')
        }
        // 归档：留本笔复核确认的这一版读数。此后新周期的上期读数只读这个值。
        const confirmed: ReadingRecord = {
          ...record,
          status: '已确认',
          reviewedAt: new Date().toISOString(),
          reviewedBy: actor.name,
          reviewNote: input.note,
          archivedValue: record.current,
        }
        const settleNo = meter.direction === '上网关口' && !confirmed.legacy
          ? draftNoFor(meter, confirmed.period)
          : confirmed.settlementNo
        confirmed.settlementNo = settleNo
        draft.readings[rIndex] = confirmed
        const mIndex = draft.meters.findIndex((item) => item.id === meter.id)
        if (mIndex >= 0) {
          draft.meters[mIndex] = { ...draft.meters[mIndex], status: '已确认' }
        }
        // 同站同周期其余已确认上网记录对齐同一张结算单号（重复复核同一批只更新一张单）。
        if (settleNo) {
          draft.readings.forEach((item, i) => {
            const otherMeter = draft.meters.find((point) => point.id === item.meterId)
            if (
              otherMeter &&
              otherMeter.stationId === meter.stationId &&
              item.period === confirmed.period &&
              item.status === '已确认' &&
              !item.legacy
            ) {
              draft.readings[i] = { ...item, settlementNo: settleNo }
            }
          })
        }
      } else {
        draft.readings[rIndex] = {
          ...record,
          status: '已抄录',
          reviewNote: input.note ? `驳回：${input.note}` : record.reviewNote,
        }
        const mIndex = draft.meters.findIndex((item) => item.id === record.meterId)
        if (mIndex >= 0) {
          draft.meters[mIndex] = { ...draft.meters[mIndex], status: '已抄录' }
        }
      }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '复核失败，整笔退回' }
  }
  return input.pass
    ? { ok: true, message: '复核通过：读数已归档，结果已进入发电结算待核算清单' }
    : { ok: true, message: '复核已驳回，抄录回到「已抄录」，可改录后重新提交' }
}

// ---------- 倍率：权限 + 校验 + 未归档期间重算 ----------

export function changeRatio(input: RatioInput, actor: Actor): { ok: boolean; message: string; recomputed?: number } {
  if (actor.role !== METER_SPECIALIST_ROLE) {
    return { ok: false, message: `只有${METER_SPECIALIST_ROLE}能改倍率，当前岗位「${actor.role}」无权操作` }
  }
  const ratioError = validateRatio(input.ratio)
  if (ratioError) {
    return { ok: false, message: `倍率校验未通过：${ratioError}` }
  }
  if (!isValidDate(input.effectiveDate)) {
    return { ok: false, message: `生效日期格式应为 YYYY-MM-DD：${input.effectiveDate}` }
  }
  let recomputed = 0
  try {
    commit((draft) => {
      const mIndex = draft.meters.findIndex((item) => item.id === input.meterId)
      if (mIndex < 0) {
        throw new FlowError(`计量点 ${input.meterId} 不在册`)
      }
      const meter = draft.meters[mIndex]
      if (actor.stationId !== meter.stationId) {
        throw new FlowError(`只能修改本电站计量点的倍率：${meter.code} 属于 ${meter.stationName}`)
      }
      if (input.effectiveDate < meter.commissionDate) {
        throw new FlowError(`生效日期不能早于投运日期 ${meter.commissionDate}；倍率历史自投运时间补起`)
      }
      const beforeEnergy = new Map(
        draft.readings
          .filter((item) => item.meterId === meter.id && item.status !== '已确认')
          .map((item) => [item.id, item.energy]),
      )
      const nextMeter: MeterPoint = {
        ...meter,
        ratioHistory: [
          ...meter.ratioHistory,
          { effectiveDate: input.effectiveDate, ratio: input.ratio, operator: actor.name, reason: input.reason || '倍率变更' },
        ],
      }
      nextMeter.ratio = ratioOnDate(nextMeter, todayIso())
      draft.meters[mIndex] = nextMeter
      // 改过倍率后未归档期间立即重算电量；已确认归档期间的账冻结不动。
      draft.readings = recomputeOpenReadings(draft.readings, nextMeter)
      recomputed = draft.readings.filter(
        (item) => item.meterId === meter.id && item.status !== '已确认' && beforeEnergy.get(item.id) !== item.energy,
      ).length
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '倍率变更失败，整笔退回' }
  }
  return {
    ok: true,
    recomputed,
    message: `倍率已变更并留痕，${recomputed} 笔未归档抄录的本期电量已重算；已复核期间保持原账不变`,
  }
}

// ---------- 批量导入老读数 ----------

export function importReadings(
  text: string,
  actor: Actor,
  allowMissing: boolean,
): ImportResult & { inserted: number } {
  const { rows, errors } = parseImportCsv(text)
  const dry = dryRunImport(rows, errors, listMeterPoints(), listReadings(), allowMissing)
  if (!dry.ok) {
    return { ...dry, inserted: 0 }
  }
  try {
    commit((draft) => {
      // commit 内再校验一次，避免预检后、落盘前状态变化。
      const recheck = dryRunImport(rows, [], draft.meters, draft.readings, true)
      if (!recheck.ok) {
        throw new FlowError(recheck.message)
      }
      for (const row of rows) {
        const meter = draft.meters.find((point) => point.code === row.code)
        if (!meter) {
          throw new FlowError(`计量点 ${row.code} 不在册`)
        }
        const previous = resolvePrevious(draft.readings, meter, row.period)
        const ratio = ratioOnDate(meter, row.readDate)
        const energy = computeEnergy(row.current, previous, ratio, row.current < previous)
        const record: ReadingRecord = {
          id: nextReadingId(draft.readings),
          meterId: meter.id,
          period: row.period,
          readDate: row.readDate,
          current: row.current,
          previous: row.current < previous ? 0 : previous,
          resetMeter: row.current < previous,
          ratio,
          energy: roundEnergy(energy),
          status: '已确认',
          submittedAt: new Date().toISOString(),
          submittedBy: actor.name,
          submitToken: `import-${meter.id}-${row.period}`,
          reviewedAt: new Date().toISOString(),
          reviewedBy: actor.name,
          reviewNote: '历史老读数批量导入，按原单留档兼容',
          legacy: true,
          archivedValue: row.current,
        }
        draft.readings.push(record)
      }
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '批量导入失败，整笔退回',
      inserted: 0,
      unknownPointRows: dry.unknownPointRows,
      missingPointCodes: dry.missingPointCodes,
    }
  }
  return {
    ok: true,
    inserted: rows.length,
    unknownPointRows: [],
    missingPointCodes: dry.missingPointCodes,
    message: `已批量归档 ${rows.length} 笔老读数${dry.missingPointCodes.length ? `；在册但本批缺失：${dry.missingPointCodes.join('、')}` : ''}`,
  }
}

// ---------- 导出 / 打印：快照冻结、切块续传 ----------

export function createExportJob(meterId: number, kind: '下载' | '打印'): ExportJob {
  const snapshot = getDetailSnapshot(meterId)
  const content = serializeSnapshot(snapshot)
  const chunks = toChunks(content)
  const now = new Date().toISOString()
  let created: ExportJob | null = null
  commit((draft) => {
    const job: ExportJob = {
      id: `JOB-${Date.now()}-${meterId}`,
      meterId,
      kind,
      filename: snapshot.filename,
      status: '进行中',
      total: chunks.length,
      cursor: 0,
      chunks,
      createdAt: now,
      updatedAt: now,
    }
    draft.jobs.push(job)
    created = job
  })
  if (!created) {
    throw new Error('导出任务创建失败')
  }
  return created
}

/**
 * 推进导出任务一块。每块（完整一行）处理完才落 cursor：
 * 中断后从 cursor 续打，已完成块不重打、未完成块不入文件，杜绝半包。
 * failAtCursor 用于演示中断。注意中断是「保留进度的正常落盘」，不能抛错，
 * 否则事务回滚会把已中断状态和 cursor 一起抹掉。
 */
export function pumpExportJob(
  jobId: string,
  opts: { steps?: number; failAtCursor?: number } = {},
): { ok: boolean; message: string; job: ExportJob; interrupted?: boolean } {
  const steps = opts.steps ?? 1
  let interrupted = false
  let interruptMessage = ''
  try {
    commit((draft) => {
      const index = draft.jobs.findIndex((item) => item.id === jobId)
      if (index < 0) {
        throw new FlowError('导出任务不存在')
      }
      const job = draft.jobs[index]
      if (job.status === '已完成') {
        return
      }
      if (job.status === '已中断') {
        job.status = '进行中'
      }
      for (let i = 0; i < steps && job.cursor < job.total; i += 1) {
        if (opts.failAtCursor !== undefined && job.cursor === opts.failAtCursor) {
          // 整块未开始：cursor 不动，状态落「已中断」，随本次事务一起持久化。
          job.status = '已中断'
          job.updatedAt = new Date().toISOString()
          interrupted = true
          interruptMessage = `导出在第 ${job.cursor + 1}/${job.total} 块中断，已保留进度，可从断点续打`
          return
        }
        // 游标即下一块下标；只有整块过完才 +1，半成品不计数。
        job.cursor += 1
      }
      job.updatedAt = new Date().toISOString()
      if (job.cursor >= job.total) {
        job.status = '已完成'
      }
    })
  } catch (error) {
    const job = listJobs().find((item) => item.id === jobId)
    return {
      ok: false,
      job: job as ExportJob,
      message: error instanceof Error ? error.message : '导出中断',
    }
  }
  const job = listJobs().find((item) => item.id === jobId) as ExportJob
  return {
    ok: !interrupted,
    interrupted,
    job,
    message: interrupted
      ? interruptMessage
      : job.status === '已完成'
        ? '导出已完成，内容与详情面板一致'
        : `导出进行中 ${job.cursor}/${job.total}`,
  }
}

export function listExportJobs(meterId?: number): ExportJob[] {
  const jobs = listJobs()
  return (meterId ? jobs.filter((job) => job.meterId === meterId) : [...jobs]).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt),
  )
}

export function exportJobContent(jobId: string): { ok: boolean; message: string; filename?: string; content?: string } {
  const job = listJobs().find((item) => item.id === jobId)
  if (!job) {
    return { ok: false, message: '导出任务不存在' }
  }
  if (job.status !== '已完成') {
    return { ok: false, message: `任务${job.status}，不能取文件，请先续打完成（当前 ${job.cursor}/${job.total}）` }
  }
  return { ok: true, message: '文件内容与详情面板一致', filename: job.filename, content: assembleJob(job) }
}

// ---------- 采集取数：失败重取，绝不清零 ----------

/**
 * 模拟从采集系统取当前读数。失败自动重试，最多 3 次；
 * 三次都取不到就抛错，由调用方保留输入框原值，绝不把本期读数清成 0。
 */
export async function fetchRemoteReading(meterId: number): Promise<{ ok: boolean; message: string; value?: number; attempts: number }> {
  let lastError = '采集链路无响应'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const got = readRemoteOnce(meterId)
    if (got.ok) {
      return { ok: true, value: got.value, attempts: attempt, message: attempt === 1 ? '取数成功' : `第 ${attempt} 次重取成功` }
    }
    lastError = got.message
    if (attempt < 3) {
      await wait(200 * attempt)
    }
  }
  return { ok: false, attempts: 3, message: `连续 3 次取数失败（${lastError}），已保留原读数未清零，请稍后重试` }
}

function readRemoteOnce(meterId: number): { ok: boolean; value?: number; message: string } {
  if (fetchFaultInjected) {
    return { ok: false, message: '采集链路超时（模拟故障）' }
  }
  const value = REMOTE_READINGS[meterId]
  if (typeof value !== 'number') {
    return { ok: false, message: '采集点无数据' }
  }
  return { ok: true, value, message: 'ok' }
}

class FlowError extends Error {}
