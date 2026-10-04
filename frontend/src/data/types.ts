/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status?: string
  pending?: boolean
  abnormal?: boolean
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ── 电量计量领域类型：抄录、倍率、归档、结算待核算清单共用 ───────────────────

/** 计量点台账（关口计量表主数据） */
export type MeterPoint = {
  id: number
  pointCode: string // 计量点编号
  stationCode: string // 所属电站编号
  stationName: string
  direction: string // 计量方向
  meterModel: string // 表计型号
  ratio: number // 当前生效倍率
  commissioningDate: string // 投运日期（倍率从这一天补起）
  status: MeterReadStatus // 最近一期抄表状态，与最新抄表记录保持一致
}

/** 抄表状态：待抄表 / 已抄录 / 待复核 / 已确认 / 已驳回 */
export type MeterReadStatus = '待抄表' | '已抄录' | '待复核' | '已确认' | '已驳回'

/** 抄表记录：一次抄录一笔，本期读数、上期读数、计量状态同生共死 */
export type MeterReading = {
  id: number
  pointCode: string
  stationCode: string
  period: string // 结算周期 YYYY-MM
  readDate: string // 抄表日期 YYYY-MM-DD
  currentReading: number // 本期读数（表底）
  previousReading: number // 上期读数（落抄那一刻冻结进本笔）
  ratio: number // 本笔生效倍率（写入前校验过）
  energy: number // 本期电量 kWh =（本期-上期）* 倍率
  status: MeterReadStatus
  requestToken: string // 幂等令牌：同一令牌重复提交只算一次
  operator: string
  rejectReason?: string
  createdAt: number
  confirmedAt?: number
  reviewer?: string
}

/** 上期读数归档：只追加不覆盖，复核确认后写死，后续抄录不得改写 */
export type MeterArchiveEntry = {
  id: number
  pointCode: string
  period: string // 该读数所属的已确认周期
  reading: number // 冻结的本期表底
  ratio: number
  energy: number
  version: number // 同一计量点同一周期的归档版本，从 1 起追加
  source: '复核确认' | '批量灌档'
  readingId: number
  archivedAt: number
}

/** 倍率版本：投运日期补一条初版，之后只追加，改倍率不改历史归档 */
export type MeterRatioChange = {
  id: number
  pointCode: string
  ratio: number
  effectiveDate: string // 生效日期，初版取投运日期
  reason: string
  operator: string
  changedAt: number
}

/** 发电结算的待核算清单：复核结果落到这里，与抄表记录两边本期电量一致 */
export type SettlementItem = {
  id: number
  itemNo: string // 清单项编号
  pointCode: string
  stationCode: string
  period: string
  energy: number // 本期电量，始终等于关联抄表记录的 energy
  readingId: number
  status: '待核算' | '已移除' // 驳回后软移除，不删历史
  confirmedAt: number
  readingRequestToken: string
}

/** 批量灌档登记：整批成功才登记，重复批次令牌只认第一次 */
export type MeterImportBatch = {
  id: number
  token: string
  total: number
  importedAt: number
  operator: string
  contentHash: string
}

/** 打印队列：逐行落断点，中断后从断点续打，不重打不半包 */
export type PrintJob = {
  id: number
  jobNo: string
  pointCode: string
  period: string
  contentHash: string // 与下载文件/详情面板同源内容的指纹
  content: string[] // 建任务时冻结的逐行内容，续打只消费这份
  totalLines: number
  deliveredLines: number // 已成功送出的行（断点）
  status: '进行中' | '已中断' | '已打完'
  driver: string
  createdAt: number
  updatedAt: number
}
