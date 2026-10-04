import { defineStore } from 'pinia'

// 岗位只用于演示倍率权限：只有「本电站的计量专责」能改倍率。
export type SessionRole = {
  name: string
  role: string
  stationId: string
  stationName: string
}

export const SESSION_ROLES: SessionRole[] = [
  { name: '计量专责-李工', role: '计量专责', stationId: 'STAT-CL-01', stationName: '苍岭光伏电站' },
  { name: '计量专责-王工', role: '计量专责', stationId: 'STAT-YS-02', stationName: '云顶光伏电站' },
  { name: '抄表员-赵姐', role: '抄表员', stationId: 'STAT-CL-01', stationName: '苍岭光伏电站' },
  { name: '值班管理员', role: '值班管理员', stationId: 'STAT-CL-01', stationName: '苍岭光伏电站' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '计量专责-李工',
    role: '计量专责',
    stationId: 'STAT-CL-01',
    stationName: '苍岭光伏电站',
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isMeterSpecialist: (state) => state.role === '计量专责',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    applyRole(role: SessionRole) {
      this.operator = role.name
      this.role = role.role
      this.stationId = role.stationId
      this.stationName = role.stationName
    },
  },
})
