import { METER_POINT_SEED, READING_SEED } from './seed'
import type { ExportJob, MeterPoint, ReadingRecord } from './types'

// 计量域独立于通用台账存储：抄录事务、倍率历史、导出任务分键存放，互不干扰。
const METER_KEY = 'pv-plant-ops:meter:points'
const READING_KEY = 'pv-plant-ops:meter:readings'
const JOB_KEY = 'pv-plant-ops:meter:export-jobs'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readKey<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

let meterCache: MeterPoint[] | null = null
let readingCache: ReadingRecord[] | null = null
let jobCache: ExportJob[] | null = null

export function listMeterPoints(): MeterPoint[] {
  if (meterCache === null) {
    meterCache = readKey(METER_KEY, METER_POINT_SEED)
  }
  return meterCache
}

export function listReadings(): ReadingRecord[] {
  if (readingCache === null) {
    readingCache = readKey(READING_KEY, READING_SEED)
  }
  return readingCache
}

export function listJobs(): ExportJob[] {
  if (jobCache === null) {
    jobCache = readKey<ExportJob[]>(JOB_KEY, [])
  }
  return jobCache
}

/**
 * 原子提交：调用方在 mutate 里对克隆快照做全部改动并返回，
 * 任一步抛错都不会触碰现存数据；最后一次写 localStorage，
 * 写失败（配额满 / 存储被禁用）时缓存也不更新，整笔退回。
 */
export function commit(mutate: (draft: {
  meters: MeterPoint[]
  readings: ReadingRecord[]
  jobs: ExportJob[]
}) => void): void {
  const draft = {
    meters: clone(listMeterPoints()),
    readings: clone(listReadings()),
    jobs: clone(listJobs()),
  }
  mutate(draft)
  persist(draft.meters, draft.readings, draft.jobs)
  meterCache = draft.meters
  readingCache = draft.readings
  jobCache = draft.jobs
}

function persist(meters: MeterPoint[], readings: ReadingRecord[], jobs: ExportJob[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const payload: [string, unknown][] = [
    [METER_KEY, meters],
    [READING_KEY, readings],
    [JOB_KEY, jobs],
  ]
  // localStorage 无法做跨键事务，先全部序列化验证，再依次写入；
  // 任一写入失败都尝试回滚到缓存快照，绝不留下半包状态。
  const serialized = payload.map(([key, value]) => [key, JSON.stringify(value)] as const)
  const backup = payload.map(([key]) => [key, window.localStorage.getItem(key)] as const)
  try {
    for (const [key, text] of serialized) {
      window.localStorage.setItem(key, text)
    }
  } catch (error) {
    for (const [key, old] of backup) {
      if (old === null) {
        window.localStorage.removeItem(key)
      } else {
        window.localStorage.setItem(key, old)
      }
    }
    throw new Error(`抄录数据落盘失败，整笔已退回：${error instanceof Error ? error.message : '未知存储错误'}`)
  }
}

export function nextReadingId(readings: ReadingRecord[]): number {
  return readings.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

export function resetMeterDomain(): void {
  meterCache = clone(METER_POINT_SEED)
  readingCache = clone(READING_SEED)
  jobCache = []
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(METER_KEY, JSON.stringify(meterCache))
    window.localStorage.setItem(READING_KEY, JSON.stringify(readingCache))
    window.localStorage.setItem(JOB_KEY, JSON.stringify(jobCache))
  }
}
