import type { MeterPoint, ReadingRecord } from './types'

// 苍岭光伏电站的关口表种子数据。M1 带一笔 2026-08 的老单据（legacy），验证旧单据照旧兼容。
export const STATION_ID = 'STAT-CL-01'
export const STATION_NAME = '苍岭光伏电站'

export const METER_POINT_SEED: MeterPoint[] = [
  {
    id: 1,
    code: 'METE-CL-01',
    direction: '上网关口',
    model: 'DTSD341-MB3 三相四线多功能表',
    stationId: STATION_ID,
    stationName: STATION_NAME,
    baseReading: 0,
    commissionDate: '2025-06-01',
    ratio: 8000,
    ratioHistory: [
      { effectiveDate: '2025-06-01', ratio: 8000, operator: '投运补录', reason: '关口表投运，倍率自投运时间补起' },
    ],
    status: '待复核',
  },
  {
    id: 2,
    code: 'METE-CL-02',
    direction: '上网关口',
    model: 'DTSD341-MB3 三相四线多功能表',
    stationId: STATION_ID,
    stationName: STATION_NAME,
    baseReading: 0,
    commissionDate: '2025-06-01',
    ratio: 400,
    ratioHistory: [
      { effectiveDate: '2025-06-01', ratio: 400, operator: '投运补录', reason: '关口表投运，倍率自投运时间补起' },
    ],
    status: '已抄录',
  },
  {
    id: 3,
    code: 'METE-CL-03',
    direction: '下网关口',
    model: 'DSSD331-MB3 三相三线多功能表',
    stationId: STATION_ID,
    stationName: STATION_NAME,
    baseReading: 0,
    commissionDate: '2025-08-15',
    ratio: 600,
    ratioHistory: [
      { effectiveDate: '2025-08-15', ratio: 600, operator: '投运补录', reason: '下网表投运，倍率自投运时间补起' },
    ],
    status: '待抄表',
  },
  {
    id: 4,
    code: 'METE-CL-04',
    direction: '站用变关口',
    model: 'DTS634 三相四线有功表',
    stationId: STATION_ID,
    stationName: STATION_NAME,
    baseReading: 0,
    commissionDate: '2025-08-15',
    ratio: 100,
    ratioHistory: [
      { effectiveDate: '2025-08-15', ratio: 100, operator: '投运补录', reason: '站用变表投运，倍率自投运时间补起' },
    ],
    status: '待抄表',
  },
  {
    id: 5,
    code: 'METE-CL-05',
    direction: '上网关口',
    model: 'DTSD341-MB3 三相四线多功能表',
    stationId: STATION_ID,
    stationName: STATION_NAME,
    baseReading: 12000,
    commissionDate: '2026-01-10',
    ratio: 500,
    ratioHistory: [
      { effectiveDate: '2026-01-10', ratio: 500, operator: '投运补录', reason: '关口表投运，倍率自投运时间补起' },
    ],
    status: '待抄表',
  },
]

export const READING_SEED: ReadingRecord[] = [
  {
    id: 1,
    meterId: 1,
    period: '2026-08',
    readDate: '2026-08-31',
    current: 218750,
    previous: 0,
    ratio: 8000,
    energy: 1750000000,
    status: '已确认',
    submittedAt: '2026-08-31T09:10:00.000Z',
    submittedBy: '抄表员-赵姐',
    submitToken: 'seed-legacy-1',
    reviewedAt: '2026-09-02T10:00:00.000Z',
    reviewedBy: '计量专责-李工',
    reviewNote: '历史系统迁入，按原读数、原倍率留档',
    legacy: true,
    archivedValue: 218750,
  },
  {
    id: 2,
    meterId: 1,
    period: '2026-09',
    readDate: '2026-09-30',
    current: 219375,
    previous: 218750,
    ratio: 8000,
    energy: 5000000,
    status: '待复核',
    submittedAt: '2026-09-30T09:12:00.000Z',
    submittedBy: '抄表员-赵姐',
    submitToken: 'seed-2',
  },
  {
    id: 3,
    meterId: 2,
    period: '2026-09',
    readDate: '2026-09-30',
    current: 1200,
    previous: 0,
    ratio: 400,
    energy: 480000,
    status: '已抄录',
    submittedAt: '2026-09-30T09:15:00.000Z',
    submittedBy: '抄表员-赵姐',
    submitToken: 'seed-3',
  },
]

// 取数模拟器用的「采集系统」当前读数；取不到时由服务层重试，连续失败只报错不清零。
export const REMOTE_READINGS: Record<number, number> = {
  1: 220000,
  2: 1260,
  3: 8800,
  4: 320,
  5: 14400,
}
