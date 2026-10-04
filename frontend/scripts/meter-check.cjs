/**
 * 电量计量领域规则无头校验：用 esbuild 把 TS 服务层打包成 CJS 后在 Node 里跑，
 * 浏览器侧只 stub window/localStorage。覆盖：事务回滚、幂等、归档冻结、
 * 倍率权限与重算、灌档点名、打印断点续打、结算对账、取不到数重取。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ENTRY = path.join(__dirname, 'meter-check-entry.ts')
const OUT = path.join(require('os').tmpdir(), 'meter-check.cjs')

function makeLocalStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    _map: map,
  }
}

async function main() {
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: OUT,
    alias: { '@': path.resolve(__dirname, '..', 'src') },
    logLevel: 'silent',
  })

  // 每次 load 模块前重置 localStorage，拿到干净播种态
  function freshService() {
    const storage = makeLocalStorage()
    global.window = { localStorage: storage }
    global.localStorage = storage
    delete require.cache[require.resolve(OUT)]
    // eslint-disable-next-line global-require
    const svc = require(OUT)
    return { svc, storage }
  }

  const chen = { key: 'chen-yf', name: '陈计量', role: '计量专责', stationCode: 'STAT-0001', stationName: '云峰光伏电站' }
  const wang = { key: 'wang-yf', name: '王抄表', role: '抄表员', stationCode: 'STAT-0001', stationName: '云峰光伏电站' }
  const gangshang = { key: 'chen-gs', name: '岗上计量专责', role: '计量专责', stationCode: 'STAT-0002', stationName: '岗上光伏电站' }
  const admin = { key: 'admin', name: '值班管理员', role: '值班管理员', stationCode: '', stationName: '全部电站' }

  let passed = 0
  async function check(name, fn) {
    try {
      await fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (error) {
      console.error(`  ✗ ${name}`)
      console.error(error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : error)
      process.exitCode = 1
    }
  }

  // ── 1. 列表/详情读数对得上账：本期、上期、电量同一份 ─────────────────────
  {
    const { svc } = freshService()
    check('列表行：METE-0002 本期/上期/电量与抄表记录一致', () => {
      const points = svc.listMeterPoints()
      const p2 = points.find((p) => p.pointCode === 'METE-0002')
      assert.equal(p2.status, '待复核')
      const detail = svc.buildMeterDocument('METE-0002')
      assert.equal(detail.reading.currentReading, 2419)
      assert.equal(detail.reading.previousReading, 2213.8)
      assert.equal(detail.previous.reading, 2213.8)
      assert.equal(detail.reading.energy, 205200)
    })
  }

  // ── 2. 抄录一次落定 + 失败整笔退回 + 重复提交只算一次 ────────────────────
  let env
  {
    env = freshService()
    const { svc } = env
    check('正常抄录：METE-0003 2026-10 按归档上期值算电量', () => {
      const res = svc.submitReading({ pointCode: 'METE-0003', period: '2026-10', readDate: '2026-10-31', currentReading: 936.2, operator: chen })
      assert.equal(res.ok, true, res.message)
      assert.equal(res.data.energy, (936.2 - 876.2) * 500)
      assert.equal(res.data.previousReading, 876.2)
    })
    check('同令牌重复提交只算一次，不产生第二笔', () => {
      const before = svc.buildMeterDocument('METE-0003')
      const token = before.reading.requestToken
      const res2 = svc.submitReading({ pointCode: 'METE-0003', period: '2026-10', readDate: '2026-10-31', currentReading: 999, operator: chen, requestToken: token })
      assert.equal(res2.ok, true)
      assert.match(res2.message, /重复提交只算一次/)
      const detail = svc.buildMeterDocument('METE-0003')
      assert.equal(detail.reading.currentReading, 936.2) // 第二次的 999 没有落进去
    })
    check('同点同期连抄两回（新令牌）被拒，电量不会算两遍', () => {
      const res = svc.submitReading({ pointCode: 'METE-0003', period: '2026-10', readDate: '2026-10-31', currentReading: 940, operator: wang })
      assert.equal(res.ok, false)
      assert.match(res.message, /同一计量点同一周期只允许一笔/)
    })
    check('落盘失败时整笔退回，读数据维持原样', () => {
      // 让 localStorage.setItem 抛错：事务先序列化落盘再改内存，失败时内存不动
      const original = env.storage.setItem.bind(env.storage)
      env.storage.setItem = () => {
        throw new Error('QuotaExceededError: 模拟落盘失败')
      }
      const res = svc.submitReading({ pointCode: 'METE-0002', period: '2026-10', readDate: '2026-10-31', currentReading: 2500, operator: chen })
      assert.equal(res.ok, false)
      assert.match(res.message, /整笔退回/)
      env.storage.setItem = original
      const detail = svc.buildMeterDocument('METE-0002')
      assert.equal(detail.reading.period, '2026-09') // 没有 2026-10 的残笔
    })
  }

  // ── 3. 复核归档冻结 + 结算待核算 + 两处电量一致 ───────────────────────────
  {
    const { svc } = freshService()
    check('复核确认：追加归档、落待核算清单、两边电量一致', () => {
      svc.submitReading({ pointCode: 'METE-0003', period: '2026-10', readDate: '2026-10-31', currentReading: 936.2, operator: wang })
      const r1 = svc.submitForReview({ pointCode: 'METE-0003', period: '2026-10', operator: wang })
      assert.equal(r1.ok, true, r1.message)
      const c1 = svc.confirmReading({ pointCode: 'METE-0003', period: '2026-10', operator: chen })
      assert.equal(c1.ok, true, c1.message)
      const detail = svc.buildMeterDocument('METE-0003')
      const arch = detail.archives.filter((a) => a.period === '2026-10')
      assert.equal(arch.length, 1)
      assert.equal(arch[0].reading, 936.2)
      assert.equal(arch[0].source, '复核确认')
      const items = svc.listSettlementPending().filter((i) => i.pointCode === 'METE-0003' && i.period === '2026-10')
      assert.equal(items.length, 1)
      assert.equal(items[0].energy, 30000)
      assert.equal(svc.reconcilePending().length, 0)
    })
    check('下一回抄录取上期时不动归档：2026-11 上期取 936.2', () => {
      const res = svc.submitReading({ pointCode: 'METE-0003', period: '2026-11', readDate: '2026-11-30', currentReading: 1000, operator: wang })
      assert.equal(res.ok, true, res.message)
      assert.equal(res.data.previousReading, 936.2)
      const detail = svc.buildMeterDocument('METE-0003')
      const arch = detail.archives.filter((a) => a.period === '2026-10')
      assert.equal(arch.length, 1) // 归档没被覆盖
    })
    check('驳回 → 重抄 → 再确认：归档不被覆盖、清单复用同一条', () => {
      // 2026-11 提交后驳回
      svc.submitForReview({ pointCode: 'METE-0003', period: '2026-11', operator: wang })
      const rej = svc.rejectReading({ pointCode: 'METE-0003', period: '2026-11', reason: '表底存疑', operator: chen })
      assert.equal(rej.ok, true, rej.message)
      assert.equal(svc.buildMeterDocument('METE-0003').reading.status, '已驳回')
      // 驳回必须有原因
      const rejNoReason = svc.rejectReading({ pointCode: 'METE-0002', period: '2026-09', operator: chen })
      assert.equal(rejNoReason.ok, false)
      // 重抄：仍只有一笔 2026-11
      const recap = svc.submitReading({ pointCode: 'METE-0003', period: '2026-11', readDate: '2026-11-30', currentReading: 1010, operator: wang })
      assert.equal(recap.ok, true, recap.message)
      svc.submitForReview({ pointCode: 'METE-0003', period: '2026-11', operator: wang })
      svc.confirmReading({ pointCode: 'METE-0003', period: '2026-11', operator: chen })
      const detail = svc.buildMeterDocument('METE-0003')
      const arch = detail.archives.filter((a) => a.period === '2026-11')
      assert.equal(arch.length, 1)
      assert.equal(arch[0].reading, 1010)
      assert.equal(detail.reading.energy, Math.round((1010 - 936.2) * 500))
    })
  }

  // ── 4. 多版归档保留：上期值由服务权衡取最新版，旧版留存 ──────────────────
  {
    const { svc } = freshService()
    check('METE-0001 2026-09 有 v1/v2 两版归档，2026-10 上期取 v2 且 v1 仍在', () => {
      const res = svc.submitReading({ pointCode: 'METE-0001', period: '2026-10', readDate: '2026-10-31', currentReading: 2400, operator: wang })
      assert.equal(res.ok, true, res.message)
      assert.equal(res.data.previousReading, 2350.6) // v2，不是 v1 的 2352.8
      const detail = svc.buildMeterDocument('METE-0001')
      const arch = detail.archives.filter((a) => a.period === '2026-09').sort((a, b) => a.version - b.version)
      assert.equal(arch.length, 2)
      assert.equal(arch[0].reading, 2352.8)
      assert.equal(arch[1].reading, 2350.6)
    })
  }

  // ── 5. 倍率：权限、写入前校验、改后重算、历史冻结、投运日补版本 ───────────
  {
    const { svc } = freshService()
    svc.submitReading({ pointCode: 'METE-0001', period: '2026-10', readDate: '2026-10-31', currentReading: 2400, operator: wang })
    check('抄表员不能改倍率', () => {
      const res = svc.changeRatio({ pointCode: 'METE-0001', ratio: 1200, effectiveDate: '2026-10-01', reason: 'CT 更换', operator: wang })
      assert.equal(res.ok, false)
      assert.match(res.message, /只有本电站的计量专责/)
    })
    check('跨电站计量专责不能改倍率', () => {
      const res = svc.changeRatio({ pointCode: 'METE-0001', ratio: 1200, effectiveDate: '2026-10-01', reason: 'CT 更换', operator: gangshang })
      assert.equal(res.ok, false)
      assert.match(res.message, /不是 云峰光伏电站 的计量专责/)
    })
    check('本电站计量专责改倍率：写入前校验非法值', () => {
      assert.equal(svc.changeRatio({ pointCode: 'METE-0001', ratio: 0, effectiveDate: '2026-10-01', reason: 'x', operator: chen }).ok, false)
      assert.equal(svc.changeRatio({ pointCode: 'METE-0001', ratio: -1, effectiveDate: '2026-10-01', reason: 'x', operator: chen }).ok, false)
      assert.equal(svc.changeRatio({ pointCode: 'METE-0001', ratio: 1200, effectiveDate: 'bad-date', reason: 'x', operator: chen }).ok, false)
      const before = svc.changeRatio({ pointCode: 'METE-0001', ratio: 1200, effectiveDate: '2024-01-01', reason: '早于投运', operator: chen })
      assert.equal(before.ok, false)
      assert.match(before.message, /投运/)
      assert.equal(svc.changeRatio({ pointCode: 'METE-0001', ratio: 1200, effectiveDate: '2026-10-01', reason: '   ', operator: chen }).ok, false)
    })
    check('改倍率后未确认电量重算，已确认电量与归档冻结不动', () => {
      const res = svc.changeRatio({ pointCode: 'METE-0001', ratio: 1200, effectiveDate: '2026-10-01', reason: 'CT 更换后变比调整', operator: chen })
      assert.equal(res.ok, true, res.message)
      const detail = svc.buildMeterDocument('METE-0001')
      assert.equal(detail.reading.energy, Math.round((2400 - 2350.6) * 1200))
      assert.equal(detail.reading.ratio, 1200)
      // 历史已确认的 2026-09 不变
      const sep = svc.buildMeterDocument('METE-0001', '2026-09')
      assert.equal(sep.reading.energy, 136800)
      const arch = detail.archives.filter((a) => a.period === '2026-09').map((a) => a.energy).sort()
      assert.deepEqual(arch, [136800, 139000])
      // 主表倍率与列表电量
      const master = svc.listMeterPoints().find((p) => p.pointCode === 'METE-0001')
      assert.equal(master.ratio, 1200)
      // 结算待核算 2026-09 仍是旧值且与抄表一致
      assert.equal(svc.reconcilePending().length, 0)
    })
    check('初始倍率从投运日期补起', () => {
      const detail = svc.buildMeterDocument('METE-0003')
      assert.equal(detail.ratios.some((r) => r.effectiveDate === '2025-03-01'), true)
      assert.equal(detail.ratios[detail.ratios.length - 1].reason, '投运建档初始倍率')
    })
  }

  // ── 6. 批量灌档：缺计量点点名到行，整批退回，重复批次只算一次 ─────────────
  {
    const { svc } = freshService()
    const bad = [
      '计量点编号,结算周期,抄表日期,本期读数,倍率,上期读数',
      'METE-0001,2026-07,2026-07-31,2090.40,1000,2000',
      'METE-9999,2026-07,2026-07-31,100,1000,50',
      'METE-0002,2026-07,bad,100,1000,50',
      'METE-0003,2026-07,2026-07-31,abc,500,10',
    ].join('\n')
    check('灌档校验失败：问题点名到行，整批一行未写', () => {
      const res = svc.importHistoricalReadings(bad, chen)
      assert.equal(res.ok, false)
      const rows = res.data.errors.map((e) => e.row).sort((a, b) => a - b)
      assert.deepEqual(rows, [3, 4, 5])
      assert.match(res.data.errors.find((e) => e.row === 3).message, /METE-9999 不存在/)
      // 第一行合法数据也没落进去
      const detail = svc.buildMeterDocument('METE-0001', '2026-07')
      assert.equal(detail.reading, null)
    })
    check('跨站灌档被点名拒绝', () => {
      const csv = 'METE-0004,2026-07,2026-07-31,900,800,800\n'
      const res = svc.importHistoricalReadings(csv, chen)
      assert.equal(res.ok, false)
      assert.match(res.data.errors[0].message, /不是 岗上光伏电站 的人员/)
    })
    const good = [
      '计量点编号,结算周期,抄表日期,本期读数,倍率,上期读数',
      'METE-0001,2026-07,2026-07-31,2090.40,1000,2000',
      'METE-0002,2026-07,2026-07-31,2050.00,1000,1980',
    ].join('\n')
    check('灌档成功：整批落定并归档；重复批次只算一次', () => {
      const res = svc.importHistoricalReadings(good, chen)
      assert.equal(res.ok, true, res.message)
      assert.equal(res.data.accepted, 2)
      const d1 = svc.buildMeterDocument('METE-0001', '2026-07')
      assert.equal(d1.reading.energy, Math.round((2090.4 - 2000) * 1000))
      assert.equal(d1.archives.some((a) => a.period === '2026-07' && a.source === '批量灌档'), true)
      const again = svc.importHistoricalReadings(good, chen)
      assert.equal(again.ok, true)
      assert.match(again.message, /重复提交只算一次/)
    })
  }

  // ── 7. 单据同源 + 打印中断续打不留半包 ───────────────────────────────────
  {
    const { svc } = freshService()
    check('下载文件与详情面板序列化结果、指纹完全一致', () => {
      const detail = svc.buildMeterDocument('METE-0001')
      const doc = svc.serializeMeterDocument(detail)
      const exported = svc.exportMeterDocument('METE-0001')
      assert.equal(exported.content, `﻿${doc.lines.join('\n')}`)
      assert.equal(exported.hash, doc.hash)
    })
    check('打印：送出两行后第三行中断，断点=2；续打从第三行继续，不重打', () => {
      const created = svc.createPrintJob('METE-0001', chen)
      assert.equal(created.ok, true, created.message)
      const jobId = created.data.id
      const sentLines = []
      let failNext = true
      svc.setPrintDriver((line) => {
        if (sentLines.length === 2 && failNext) {
          // 第三行（索引 2）第一次送失败
          return false
        }
        sentLines.push(line)
        return true
      })
      // 第一推：每行都尝试；第三行失败 → delivered 2
      const first = svc.advancePrintJob(jobId, 100)
      assert.equal(first.ok, false)
      assert.equal(first.data.deliveredLines, 2)
      assert.equal(first.data.status, '已中断')
      assert.equal(sentLines.length, 2)
      // 续打：第一、二行不再送
      failNext = false
      const rest = svc.advancePrintJob(jobId, 100)
      assert.equal(rest.ok, true, rest.message)
      assert.equal(rest.data.status, '已打完')
      assert.equal(sentLines.length, created.data.totalLines)
      // 续打后再推一次是 no-op
      const again = svc.advancePrintJob(jobId, 100)
      assert.match(again.message, /已打完/)
      assert.equal(sentLines.length, created.data.totalLines)
    })
    check('手动中断：断点保留在中断处，可续打', () => {
      const created = svc.createPrintJob('METE-0002', chen)
      const jobId = created.data.id
      let count = 0
      svc.setPrintDriver(() => {
        count += 1
        return true
      })
      svc.advancePrintJob(jobId, 2) // 送出前两行
      svc.requestAbortPrint(jobId)
      const stopped = svc.advancePrintJob(jobId, 100)
      assert.equal(stopped.data.status, '已中断')
      assert.equal(stopped.data.deliveredLines, 2)
      assert.equal(count, 2)
      const resumed = svc.advancePrintJob(jobId, 100)
      assert.equal(resumed.data.status, '已打完')
      assert.equal(count, created.data.totalLines)
    })
  }

  // ── 8. 取不到数时重取而不是清零 ─────────────────────────────────────────
  {
    const { svc } = freshService()
    await check('表计取数：前两次失败自动重取，第三次成功，不清零', async () => {
      let n = 0
      svc.setMeterDialDriver(() => {
        n += 1
        if (n < 3) {
          throw new Error('表计通讯超时')
        }
        return 1234.56
      })
      const res = await svc.fetchMeterReading('METE-0001', 3)
      assert.equal(res.ok, true, res.message)
      assert.equal(n, 3)
      assert.equal(res.data.reading, 1234.56)
      assert.equal(res.data.attempts, 3)
    })
    await check('三次全失败：返回失败、不写任何读数', async () => {
      svc.setMeterDialDriver(() => {
        throw new Error('表计通讯超时')
      })
      const res = await svc.fetchMeterReading('METE-0001', 3)
      assert.equal(res.ok, false)
      assert.match(res.message, /取不到数.*保留未清零/)
      svc.setMeterDialDriver(null)
    })
  }

  // ── 9. 老单据兼容：无归档时回退上期已确认抄表单 ─────────────────────────
  {
    const { storage } = freshService()
    check('没有归档的老计量点，上期值从老抄表单取；都没有则要求手工录入', () => {
      // 先触发播种，再在存储里造一个只有老抄表记录、没有归档的点
      const seed = require(OUT)
      seed.listMeterPoints()
      const raw = JSON.parse(storage.getItem('pv-plant-ops:entries:v2'))
      raw.meter.push({
        id: 99, status: '待抄表', pending: true, abnormal: false,
        '计量点编号': 'METE-0099', '电站编号': 'STAT-0001', '所属电站': '云峰光伏电站',
        '计量方向': '上网关口', '表计型号': '老表', '倍率': 100, '投运日期': '2026-01-01',
        '结算周期': '', '抄表日期': '', '本期读数': '', '上期读数': '', '本期电量': '', '计量状态': '待抄表',
      })
      raw.meterRatios.push({ id: 99, pointCode: 'METE-0099', ratio: 100, effectiveDate: '2026-01-01', reason: '投运建档初始倍率', operator: '系统', changedAt: Date.now() })
      raw.meterReadings.push({
        id: 9901, pointCode: 'METE-0099', stationCode: 'STAT-0001', period: '2026-09', readDate: '2026-09-30',
        currentReading: 500, previousReading: 400, ratio: 100, energy: 10000, status: '已确认',
        requestToken: 'legacy-1', operator: '老抄表员', createdAt: Date.now(), confirmedAt: Date.now(),
      })
      raw.meter.push({
        id: 98, status: '待抄表', pending: true, abnormal: false,
        '计量点编号': 'METE-0098', '电站编号': 'STAT-0001', '所属电站': '云峰光伏电站',
        '计量方向': '上网关口', '表计型号': '新表', '倍率': 100, '投运日期': '2026-10-01',
        '结算周期': '', '抄表日期': '', '本期读数': '', '上期读数': '', '本期电量': '', '计量状态': '待抄表',
      })
      raw.meterRatios.push({ id: 98, pointCode: 'METE-0098', ratio: 100, effectiveDate: '2026-10-01', reason: '投运建档初始倍率', operator: '系统', changedAt: Date.now() })
      storage.setItem('pv-plant-ops:entries:v2', JSON.stringify(raw))
      // 重新加载服务，让它从改过的存储初始化
      delete require.cache[require.resolve(OUT)]
      const svc = require(OUT)
      const res = svc.submitReading({ pointCode: 'METE-0099', period: '2026-10', readDate: '2026-10-31', currentReading: 620, operator: chen })
      assert.equal(res.ok, true, res.message)
      assert.equal(res.data.previousReading, 500)
      assert.equal(res.data.energy, 12000)
      // 全新点：既无归档也无老单 → 拒绝并提示手工录入，绝不填 0
      const noPrev = svc.submitReading({ pointCode: 'METE-0098', period: '2026-10', readDate: '2026-10-31', currentReading: 100, operator: chen })
      assert.equal(noPrev.ok, false)
      assert.match(noPrev.message, /手工录入上期读数/)
      const withManual = svc.submitReading({ pointCode: 'METE-0098', period: '2026-10', readDate: '2026-10-31', currentReading: 100, manualPrevious: 20, operator: chen })
      assert.equal(withManual.ok, true, withManual.message)
      assert.equal(withManual.data.energy, 8000)
      // 供下一条断言使用同一服务实例
      check._svc = svc
    })
    check('值班管理员可跨站操作抄录，但倍率仍限计量专责', () => {
      const svc = check._svc
      const res = svc.submitReading({ pointCode: 'METE-0004', period: '2026-10', readDate: '2026-10-31', currentReading: 1200, operator: admin })
      assert.equal(res.ok, true, res.message)
      const denied = svc.changeRatio({ pointCode: 'METE-0004', ratio: 900, effectiveDate: '2026-10-01', reason: 'x', operator: admin })
      assert.equal(denied.ok, false)
    })
  }

  // ── 10. 通用导出仍包含计量主表中文列 ─────────────────────────────────────
  {
    const { svc } = freshService()
    check('导出 CSV 含本期读数/上期读数/本期电量列，且与列表同源', () => {
      const doc = svc.exportMeterDocument('METE-0002')
      assert.match(doc.content, /本期电量/)
      assert.match(doc.content, /2419/)
      assert.match(doc.content, /2213\.8/)
    })
  }

  console.log(`\n${passed} 项校验通过`)
  if (process.exitCode) {
    console.error('存在失败项')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
