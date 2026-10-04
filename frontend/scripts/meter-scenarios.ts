// 计量域业务场景验证脚本（仅开发用，不进构建产物）
// 运行：node scripts/meter-scenarios.mjs（由 esbuild 预打包，见 package.json 旁的临时命令）
import assert from 'node:assert'

import {
  buildPanelSnapshot,
  computeEnergy,
  dryRunImport,
  parseImportCsv,
  ratioOnDate,
  serializeSnapshot,
  settlementDrafts,
  toChunks,
  validateRatio,
  jobPercent,
} from '../src/data/meter/engine'
import {
  changeRatio,
  createExportJob,
  exportJobContent,
  getAllReadings,
  getDetailSnapshot,
  getMeterList,
  getReadings,
  getSettlementDrafts,
  importReadings,
  listExportJobs,
  pumpExportJob,
  reviewReading,
  sendForReview,
  submitReading,
  type Actor,
} from '../src/data/meter/service'
import { listMeterPoints, resetMeterDomain } from '../src/data/meter/store'

const specialist: Actor = { name: '计量专责-李工', role: '计量专责', stationId: 'STAT-CL-01' }
const otherStationSpecialist: Actor = { name: '计量专责-王工', role: '计量专责', stationId: 'STAT-YS-02' }
const reader: Actor = { name: '抄表员-赵姐', role: '抄表员', stationId: 'STAT-CL-01' }

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function readingOf(meterId: number, period: string) {
  const item = getReadings(meterId).find((r) => r.period === period)
  if (!item) throw new Error(`缺少记录 ${meterId} ${period}`)
  return item
}

resetMeterDomain()

// 1. 纯函数
check('倍率校验拒绝 0 / 负数 / 非数字', () => {
  assert.ok(validateRatio(0))
  assert.ok(validateRatio(-5))
  assert.ok(validateRatio(Number.NaN))
  assert.strictEqual(validateRatio(8000), null)
})
check('电量计算 (本期-上期)×倍率', () => {
  assert.strictEqual(computeEnergy(100, 80, 400), 8000)
})
check('倍率自投运时间补起，按日期解析生效倍率', () => {
  const m1 = listMeterPoints()[0]
  assert.strictEqual(ratioOnDate(m1, '2025-06-01'), 8000)
  assert.strictEqual(ratioOnDate(m1, '2026-01-01'), 8000)
})

// 2. 种子状态：M1 八月老单据已归档，九月待复核
check('老单据 2026-08 已确认归档且带 legacy 标记', () => {
  const aug = readingOf(1, '2026-08')
  assert.strictEqual(aug.status, '已确认')
  assert.strictEqual(aug.legacy, true)
  assert.strictEqual(aug.archivedValue, 218750)
})

// 3. 列表展示：M1 九月本期/上期都在，同一行能对账
check('列表 M1 九月本期与上期读数同单可见（对得上账）', () => {
  const m1 = getMeterList().find((m) => m.id === 1)!
  assert.strictEqual(m1.lastPrevious, 218750)
  assert.strictEqual(m1.lastCurrent, 219375)
  assert.strictEqual(m1.lastEnergy, 5000000)
})

// 4. 幂等：同一 token 连抄两遍只算一次
const token = 'test-token-dup'
const r1 = submitReading({ meterId: 3, period: '2026-09', readDate: '2026-09-30', current: 9000, operator: reader.name, token })
const r2 = submitReading({ meterId: 3, period: '2026-09', readDate: '2026-09-30', current: 9000, operator: reader.name, token })
check('重复提交（同令牌）只落一笔，第二次返回 duplicated', () => {
  assert.strictEqual(r1.ok, true)
  assert.strictEqual(r1.duplicated, false)
  assert.strictEqual(r2.ok, true)
  assert.strictEqual(r2.duplicated, true)
  const samePeriod = getReadings(3).filter((r) => r.period === '2026-09')
  assert.strictEqual(samePeriod.length, 1)
})

// 5. 不同令牌同周期也算重复、不计两遍
const r3 = submitReading({ meterId: 3, period: '2026-09', readDate: '2026-09-30', current: 9001, operator: reader.name, token: 'other-token' })
check('不同令牌同周期仍拒绝重复计电量', () => {
  assert.strictEqual(r3.ok, false)
  assert.match(r3.message, /已抄录/)
})

// 6. 原子退回：非法/倒走读数 → 整笔退回
const before = getReadings(4).length
const bad = submitReading({ meterId: 4, period: '2026-09', readDate: '2026-09-30', current: -10, operator: reader.name, token: 'bad-1' })
check('读数非法整笔退回，不产生半截记录', () => {
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(getReadings(4).length, before)
})
// M3 九月抄录尚未复核确认，十月上期不允许拿它，应回落装表底数 0。
check('未复核期间不作为下期上期来源（回落到装表底数）', () => {
  const probe = submitReading({ meterId: 3, period: '2026-10', readDate: '2026-10-31', current: 100, operator: reader.name, token: 'probe-1' })
  assert.strictEqual(probe.ok, true)
  assert.strictEqual(probe.reading!.previous, 0)
  // 清掉试探记录的影响：直接驳回路径不走，改用倒走判定——对底数 0 来说 100 是正向，故通过。
})
const backward = submitReading({ meterId: 5, period: '2026-09', readDate: '2026-09-30', current: 100, operator: reader.name, token: 'bad-2' })
check('本期读数小于上期/底数（M5 底数 12000→100）默认拒绝，除非换表起算', () => {
  assert.strictEqual(backward.ok, false)
  assert.match(backward.message, /小于上期读数/)
})
const reset = submitReading({ meterId: 5, period: '2026-09', readDate: '2026-09-30', current: 120, operator: reader.name, token: 'reset-1', resetMeter: true })
check('换表倒行勾选后按新表起算，电量=本期×倍率', () => {
  assert.strictEqual(reset.ok, true)
  assert.strictEqual(reset.reading!.energy, 120 * 500)
  assert.strictEqual(reset.reading!.previous, 0)
})

// 7. 倍率权限
check('非计量专责不能改倍率', () => {
  const denied = changeRatio({ meterId: 1, ratio: 9000, effectiveDate: '2026-10-01', operator: reader.name, reason: 'x' }, reader)
  assert.strictEqual(denied.ok, false)
  assert.match(denied.message, /计量专责/)
})
check('外电站计量专责不能改本电站倍率', () => {
  const denied = changeRatio({ meterId: 1, ratio: 9000, effectiveDate: '2026-10-01', operator: otherStationSpecialist.name, reason: 'x' }, otherStationSpecialist)
  assert.strictEqual(denied.ok, false)
  assert.match(denied.message, /本电站/)
})
check('倍率非法（负数）写入前校验拒绝', () => {
  const denied = changeRatio({ meterId: 1, ratio: -1, effectiveDate: '2026-10-01', operator: specialist.name, reason: 'x' }, specialist)
  assert.strictEqual(denied.ok, false)
})
check('生效日期早于投运日期拒绝', () => {
  const denied = changeRatio({ meterId: 1, ratio: 9000, effectiveDate: '2020-01-01', operator: specialist.name, reason: 'x' }, specialist)
  assert.strictEqual(denied.ok, false)
  assert.match(denied.message, /投运/)
})

// 8. 改倍率后未归档期间重算；已确认期间不动
// M2 九月已抄录未复核，原电量 (1200-0)*400=480000。
const m2SepBefore = readingOf(2, '2026-09')
assert.strictEqual(m2SepBefore.energy, 480000)
const change = changeRatio({ meterId: 2, ratio: 500, effectiveDate: '2026-09-15', operator: specialist.name, reason: '互感器更换' }, specialist)
check('改倍率后未归档期间自动重算，重算笔数正确上报', () => {
  assert.strictEqual(change.ok, true)
  assert.strictEqual(change.recomputed, 1)
  assert.strictEqual(readingOf(2, '2026-09').energy, 1200 * 500)
})
check('已确认归档期间（M1 八月老单据）电量冻结不重算', () => {
  assert.strictEqual(readingOf(1, '2026-08').energy, 1750000000)
})
check('倍率历史留痕，投运补录那笔仍在', () => {
  const m2 = getMeterList().find((m) => m.id === 2)!
  assert.strictEqual(m2.ratioHistory.length, 2)
  assert.strictEqual(m2.ratioHistory[0].operator, '投运补录')
  assert.strictEqual(m2.ratioHistory[1].ratio, 500)
})

// 9. 复核归档 + 结算联动
const m2Id = readingOf(2, '2026-09').id
sendForReview(m2Id, reader)
const reviewM1 = reviewReading({ readingId: readingOf(1, '2026-09').id, pass: true, reviewer: specialist.name }, specialist)
const reviewM2 = reviewReading({ readingId: m2Id, pass: true, reviewer: specialist.name }, specialist)
check('复核通过后状态已确认且归档读数固化', () => {
  assert.strictEqual(reviewM1.ok, true)
  assert.strictEqual(readingOf(1, '2026-09').status, '已确认')
  assert.strictEqual(readingOf(1, '2026-09').archivedValue, 219375)
  assert.strictEqual(readingOf(2, '2026-09').status, '已确认')
})
check('复核结果落到结算待核算清单，两处本期电量对得上', () => {
  const sep = getSettlementDrafts().find((d) => d.period === '2026-09')
  assert.ok(sep, '应有 2026-09 待核算单')
  // M1: 5,000,000；M2 重算后: 600,000
  assert.strictEqual(sep!.energy, 5600000)
  const sum = sep!.readingIds
    .map((id) => getAllReadings().find((r) => r.id === id)!.energy)
    .reduce((a, b) => a + b, 0)
  assert.strictEqual(sum, sep!.energy)
})
check('下网/站用变电量不进结算', () => {
  const ids = getSettlementDrafts().flatMap((d) => d.readingIds)
  assert.ok(!ids.includes(readingOf(3, '2026-09').id))
})
check('历史老单据不重复挂待核算，但仍是后续周期上期来源', () => {
  assert.strictEqual(getSettlementDrafts().filter((d) => d.period === '2026-08').length, 0)
  const submitOct = submitReading({ meterId: 1, period: '2026-10', readDate: '2026-10-31', current: 220000, operator: reader.name, token: 'm1-oct' })
  assert.strictEqual(submitOct.ok, true)
  assert.strictEqual(submitOct.reading!.previous, 219375)
})

// 10. 归档后不许被下一回覆盖
check('对已确认期间再次提交被拒绝（归档只读）', () => {
  const again = submitReading({ meterId: 1, period: '2026-09', readDate: '2026-09-30', current: 999999, operator: reader.name, token: 'cover-attempt' })
  assert.strictEqual(again.ok, false)
  assert.match(again.message, /归档/)
  assert.strictEqual(readingOf(1, '2026-09').current, 219375)
})

// 11. 批量导入点名
const csvBad = [
  '计量点编号,周期,抄表日期,本期读数',
  'METE-CL-03,2026-07,2026-07-31,7000',
  'METE-UNKNOWN,2026-07,2026-07-31,100',
].join('\n')
check('导入解析能点名未知计量点到 CSV 行号', () => {
  const { rows, errors } = parseImportCsv(csvBad)
  assert.strictEqual(errors.length, 0)
  const dry = dryRunImport(rows, [], listMeterPoints(), getAllReadings(), false)
  assert.strictEqual(dry.ok, false)
  assert.deepStrictEqual(dry.unknownPointRows, [{ row: 3, code: 'METE-UNKNOWN' }])
})
check('未知点存在时整批退回，一条都不入库', () => {
  const beforeCount = getAllReadings().length
  const res = importReadings(csvBad, specialist, true)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(getAllReadings().length, beforeCount)
})
const csvOnlyOne = [
  '计量点编号,周期,抄表日期,本期读数',
  'METE-CL-04,2026-08,2026-08-31,200',
].join('\n')
check('在册但文件缺失的计量点点名编号，需二次确认放行', () => {
  const first = importReadings(csvOnlyOne, specialist, false)
  assert.strictEqual(first.ok, false)
  assert.ok(first.missingPointCodes.includes('METE-CL-01'))
  const second = importReadings(csvOnlyOne, specialist, true)
  assert.strictEqual(second.ok, true)
  assert.strictEqual(second.inserted, 1)
})
check('导入的老读数标记 legacy、已归档、不进待核算', () => {
  const imp = readingOf(4, '2026-08')
  assert.strictEqual(imp.legacy, true)
  assert.strictEqual(imp.status, '已确认')
  assert.ok(!getSettlementDrafts().some((d) => d.period === '2026-08'))
})
check('重复灌同一计量点周期被点名并整批拒绝', () => {
  const again = importReadings(csvOnlyOne, specialist, true)
  assert.strictEqual(again.ok, false)
  assert.match(again.message, /已有抄录/)
})
check('坏行（周期/日期/数字非法）按行号报错', () => {
  const badRows = [
    '计量点编号,周期,抄表日期,本期读数',
    'METE-CL-03,2026/07,2026-07-31,7000',
    'METE-CL-03,2026-07,not-a-date,7000',
    'METE-CL-03,2026-07,2026-07-31,abc',
  ].join('\n')
  const { errors } = parseImportCsv(badRows)
  assert.strictEqual(errors.length, 3)
})

// 12. 导出任务：冻结快照、切块、断点续传、不留半包
const job = createExportJob(1, '下载')
check('导出任务按行切块，初始 cursor=0、进行中', () => {
  assert.strictEqual(job.total, toChunks(serializeSnapshot(getDetailSnapshot(1))).length)
  assert.strictEqual(job.cursor, 0)
  assert.strictEqual(job.status, '进行中')
})
pumpExportJob(job.id, { steps: 3 })
check('打 3 块后进度 3/total，未完成不能取文件', () => {
  const j = listExportJobs(1)[0]
  assert.strictEqual(j.cursor, 3)
  assert.strictEqual(exportJobContent(job.id).ok, false)
})
pumpExportJob(job.id, { steps: 1, failAtCursor: 3 })
check('在第 4 块前模拟中断：cursor 停在 3、状态已中断', () => {
  const j = listExportJobs(1)[0]
  assert.strictEqual(j.status, '已中断')
  assert.strictEqual(j.cursor, 3)
})
pumpExportJob(job.id, { steps: 999 })
check('从中断处续打至完成，拼装内容与面板快照逐字节一致', () => {
  const j = listExportJobs(1)[0]
  assert.strictEqual(j.status, '已完成')
  assert.strictEqual(j.cursor, j.total)
  const out = exportJobContent(job.id)
  assert.strictEqual(out.ok, true)
  assert.strictEqual(out.content, serializeSnapshot(getDetailSnapshot(1)))
})
check('导出文件含详情面板的档案、倍率历史、台账三段', () => {
  const out = exportJobContent(job.id).content!
  assert.match(out, /关口计量表抄录明细/)
  assert.match(out, /倍率历史/)
  assert.match(out, /METE-CL-01/)
  assert.match(out, /5000000/)
})
check('任务进度百分比', () => {
  assert.strictEqual(jobPercent({ cursor: 5, total: 10 } as never), 50)
})

// 13. 面板与导出同源
check('面板快照读数行周期齐全、状态与存储一致', () => {
  const snap = buildPanelSnapshot(
    listMeterPoints()[0],
    getReadings(1),
    new Set(getSettlementDrafts().flatMap((d) => d.readingIds)),
  )
  const periods = snap.readingRows.map((row) => String(row.周期))
  assert.deepStrictEqual(periods, ['2026-10', '2026-09', '2026-08'])
  const sep = snap.readingRows.find((row) => String(row.周期) === '2026-09')!
  assert.strictEqual(sep.计量状态, '已确认')
  assert.ok(String(sep.结算单号).startsWith('SETT-2026-09'))
})

// 14. 驳回路径
const m5Submit = submitReading({ meterId: 5, period: '2026-10', readDate: '2026-10-31', current: 14500, operator: reader.name, token: 'm5-oct' })
check('首次抄录上期取装表底数', () => {
  assert.strictEqual(m5Submit.ok, true)
  assert.strictEqual(m5Submit.reading!.previous, 12000)
  assert.strictEqual(m5Submit.reading!.energy, (14500 - 12000) * 500)
})
sendForReview(m5Submit.reading!.id, reader)
const reject = reviewReading({ readingId: m5Submit.reading!.id, pass: false, reviewer: specialist.name, note: '读数存疑' }, specialist)
check('复核驳回回到已抄录', () => {
  assert.strictEqual(reject.ok, true)
  assert.strictEqual(readingOf(5, '2026-10').status, '已抄录')
})

console.log(`\n全部 ${passed} 项场景验证通过`)
