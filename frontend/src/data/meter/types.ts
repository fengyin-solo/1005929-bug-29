/**
 * 电量计量业务域类型。
 *
 * 与通用台账（EntryRow）分开：关口计量表的抄录是「一次落定」的事务，
 * 本期读数、上期读数、倍率与计量状态必须同生共死，不能只写进去一半。
 */

export type MeterStatus = '待抄表' | '已抄录' | '待复核' | '已确认'
/** 计量方向：只有上网关口的本期电量进发电结算；下网/站用变只抄不结算。 */
export type MeterDirection = '上网关口' | '下网关口' | '站用变关口'

/** 倍率变更记录。倍率历史从投运时间补起，之后每次变更都留痕，不做原地覆盖。 */
export type RatioChange = {
  /** 生效日期（YYYY-MM-DD），投运那一笔取投运日期。 */
  effectiveDate: string
  ratio: number
  /** 变更人，投运补录那笔标注为「投运补录」。 */
  operator: string
  reason: string
}

export type MeterPoint = {
  id: number
  code: string
  direction: MeterDirection
  model: string
  stationId: string
  stationName: string
  /** 装表底数：第一次抄录时作为上期读数，保证「上期那格」从第一天起就有数。 */
  baseReading: number
  commissionDate: string
  ratio: number
  ratioHistory: RatioChange[]
  status: MeterStatus
}

export type ReadingStatus = '已抄录' | '待复核' | '已确认'

/**
 * 抄录记录。一条就是一笔不可拆的事务：
 * current（本期读数）、previous（上期读数快照）、ratio（当时倍率）、energy（本期电量）同时落定。
 */
export type ReadingRecord = {
  id: number
  meterId: number
  /** 结算周期（YYYY-MM），同一计量点同一周期只允许一笔，重复提交幂等。 */
  period: string
  readDate: string
  current: number
  /** 抄录时认定的上期读数：取该计量点最近一笔已确认读数（老单据兼容时取归档快照）。 */
  previous: number
  /** 落定时使用的倍率；此后倍率再改也不会回头动这笔账。 */
  ratio: number
  /** 本期电量 = (本期读数 - 上期读数) × 倍率，落定时一次算死。 */
  energy: number
  status: ReadingStatus
  submittedAt: string
  submittedBy: string
  /** 幂等令牌：同一令牌连点两回只落一笔。 */
  submitToken: string
  /** 复核结论，归档后不再允许改写。 */
  reviewedAt?: string
  reviewedBy?: string
  reviewNote?: string
  /** 老单据批量灌入的历史抄录：复核与结算照旧兼容，但不参与新流程的覆盖。 */
  legacy?: boolean
  /** 复核确认时归档的读数版本（默认即本笔本期读数，留字段以便记录「留哪一版」的决策）。 */
  archivedValue?: number
  /** 复核后联动生成/更新的结算单号。 */
  settlementNo?: string
  /** 换表倒行：本期按新表起算（上期按 0）。 */
  resetMeter?: boolean
}

export type SubmitReadingInput = {
  meterId: number
  period: string
  readDate: string
  current: number
  operator: string
  /** 前端生成的幂等令牌（crypto.randomUUID 或时间戳兜底）。 */
  token: string
  /** 换表等倒行场景必须显式声明，否则本期读数小于上期读数一律拒绝（整笔退回）。 */
  resetMeter?: boolean
}

export type ReviewInput = {
  readingId: number
  /** true=复核通过并归档；false=复核驳回，回到已抄录允许重录。 */
  pass: boolean
  reviewer: string
  note?: string
}

export type RatioInput = {
  meterId: number
  ratio: number
  effectiveDate: string
  operator: string
  reason: string
}

export type ImportedReadingRow = {
  code: string
  period: string
  readDate: string
  current: number
  legacy?: boolean
}

export type ImportResult = {
  ok: boolean
  message: string
  inserted: number
  /** 点名到行号：文件里引用了不存在的计量点（1 起始，对应 CSV 数据行）。 */
  unknownPointRows: { row: number; code: string }[]
  /** 点名到计量点：登记在册、但本批文件里一笔都没给的计量点。 */
  missingPointCodes: string[]
}

export type JobStatus = '进行中' | '已完成' | '已中断'

/**
 * 导出/打印任务。快照在任务创建时冻结（与详情面板同源拼装），
 * 每打完一块就落一次进度；中断后按 cursor 续打，绝不输出半包文件。
 */
export type ExportJob = {
  id: string
  meterId: number
  kind: '下载' | '打印'
  filename: string
  status: JobStatus
  total: number
  /** 已完成块数，也是续传起点。 */
  cursor: number
  chunks: string[]
  createdAt: string
  updatedAt: string
}

export type SettlementDraft = {
  no: string
  period: string
  stationId: string
  stationName: string
  energy: number
  readingIds: number[]
}
