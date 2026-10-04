<template>
  <section class="page" data-module="settlement">
    <header class="page-head">
      <div>
        <h2>发电结算管理</h2>
        <p class="page-desc">维护电量结算单，围绕结算单号、结算周期、上网电量、结算电价做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记电量结算单</button>
        <button class="btn" type="button" @click="exportRows">导出发电结算清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="reconcile-strip">
      <div>
        <strong>关口表复核待核算清单</strong>
        <span class="muted">电量计量复核确认后落到这里，两处本期电量必须一致；取不到清单时重取，不清零。共 {{ pendingItems.length }} 条</span>
      </div>
      <button class="btn" type="button" @click="runReconcile">与抄表记录对账</button>
    </div>
    <table v-if="pendingItems.length" class="data-table mini">
      <thead>
        <tr><th>清单项编号</th><th>计量点</th><th>电站</th><th>周期</th><th>本期电量(kWh)</th><th>状态</th><th>复核时间</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in pendingItems" :key="item.id">
          <td>{{ item.itemNo }}</td>
          <td>{{ item.pointCode }}</td>
          <td>{{ stationName(item.stationCode) }}</td>
          <td>{{ item.period }}</td>
          <td>{{ item.energy }}</td>
          <td>{{ item.status }}</td>
          <td>{{ formatTime(item.confirmedAt) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="reconcileMessage" :class="reconcileOk ? 'ok-text' : 'error-text'">{{ reconcileMessage }}</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无发电结算数据，可先登记电量结算单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条发电结算记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  listMeterPoints,
  listSettlementPending,
  reconcilePending,
} from '@/api/meter-service'
import type { EntryRow, SettlementItem } from '@/data/types'

const meta = moduleMeta('settlement')
const columns = ["结算单号", "结算周期", "上网电量", "结算电价", "补贴金额", "结算金额", "开票状态", "结算状态"]
const actions = ["发起核算", "确认结算", "登记开票"]
const statuses = ["待核算", "核算中", "已确认", "已开票"]
const stats = [{"label": "待核算结算单", "value": 0}, {"label": "本月上网电量", "value": 0}, {"label": "本月结算金额", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const pendingItems = ref<SettlementItem[]>([])
const reconcileMessage = ref('')
const reconcileOk = ref(false)
const points = listMeterPoints()
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function stationName(stationCode: string): string {
  return points.find((point) => point.stationCode === stationCode)?.stationName ?? stationCode
}
function formatTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

function runReconcile() {
  const mismatches = reconcilePending()
  reconcileOk.value = mismatches.length === 0
  reconcileMessage.value = mismatches.length
    ? `发现 ${mismatches.length} 处不一致：${mismatches.map((m) => `${m.itemNo} 清单 ${m.actual} / 抄表 ${m.expected}`).join('；')}`
    : `对账通过：待核算清单 ${pendingItems.value.length} 项的本期电量与抄表记录全部一致`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '电量结算单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    pendingItems.value = listSettlementPending()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发电结算列表读取失败'
  }
}

onMounted(reload)
</script>
