import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：电量计量拆出抄表/归档/倍率/待核算/打印队列表，老数据结构不兼容，换新键。
const STORAGE_KEY = 'pv-plant-ops:entries:v2'

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 一次性提交全部表：任一表构造失败就不写，整笔退回。 */
export function commitTables(tables: Record<string, EntryRow[]>): void {
  // 先在快照上序列化，序列化抛错说明数据本身坏了，原缓存保持不动。
  const snapshot = JSON.stringify({ ...allRows(), ...tables })
  const next = { ...allRows(), ...tables }
  if (typeof window !== 'undefined' && window.localStorage) {
    // setItem 可能因配额等原因抛错：先改持久化再改内存，失败时内存也不动。
    window.localStorage.setItem(STORAGE_KEY, snapshot)
  }
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitTables({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 事务式多表读写：fn 拿到的是全表深拷贝，里面随便改；正常返回才整体落盘，
 * 落盘失败或 fn 抛错都整笔回滚，调用方收到异常。返回值透传给调用方。
 */
export function withTransaction<T>(fn: (draft: Record<string, EntryRow[]>) => T): T {
  const draft = clone(allRows())
  const result = fn(draft)
  commitTables(draft as Record<string, EntryRow[]>)
  return result
}

export function storageKey(): string {
  return STORAGE_KEY
}
