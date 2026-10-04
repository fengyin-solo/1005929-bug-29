import { defineStore } from 'pinia'

/** 可切换的值班身份：演示「只有本电站的计量专责能改倍率」用 */
export type OperatorProfile = {
  key: string
  name: string
  role: '计量专责' | '抄表员' | '值班管理员'
  stationCode: string // 归属电站，空串代表厂级/跨站账号
  stationName: string
}

export const OPERATOR_PROFILES: OperatorProfile[] = [
  { key: 'chen-yf', name: '陈计量', role: '计量专责', stationCode: 'STAT-0001', stationName: '云峰光伏电站' },
  { key: 'wang-yf', name: '王抄表', role: '抄表员', stationCode: 'STAT-0001', stationName: '云峰光伏电站' },
  { key: 'chen-gs', name: '岗上计量专责', role: '计量专责', stationCode: 'STAT-0002', stationName: '岗上光伏电站' },
  { key: 'admin', name: '值班管理员', role: '值班管理员', stationCode: '', stationName: '全部电站' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    profileKey: 'chen-yf',
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
  }),
  getters: {
    profile(state): OperatorProfile {
      return OPERATOR_PROFILES.find((item) => item.key === state.profileKey) ?? OPERATOR_PROFILES[0]
    },
    operator(): string {
      return this.profile.name
    },
    canOperate(): boolean {
      return this.profile.name.length > 0
    },
  },
  actions: {
    setProfile(key: string) {
      this.profileKey = key
    },
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
