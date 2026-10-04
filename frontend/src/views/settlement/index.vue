<template>
  <section class="page" data-module="settlement">
    <header class="page-head">
      <div>
        <h2>发电结算管理</h2>
        <p class="page-desc">
          维护电量结算单。计量复核通过的上网关口电量自动进入下方「计量复核待核算清单」，
          清单电量就是抄录记录里的本期电量，两处对得上才能发起核算。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出发电结算清单</button>
      </div>
    </header>

    <h3 class="block-title">计量复核待核算清单（来自关口表复核结果）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>待核算单号</th>
          <th>结算周期</th>
          <th>电站</th>
          <th>本期电量合计(kWh)</th>
          <th>关联抄录记录</th>
          <th>核对状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="draft in meterDrafts" :key="draft.no">
          <td>{{ draft.no }}</td>
          <td>{{ draft.period }}</td>
          <td>{{ draft.stationName }}</td>
          <td>{{ draft.energy }}</td>
          <td>
            <span v-for="(id, i) in draft.readingIds" :key="id" class="chip">
              #{{ id }}（{{ readingEnergy(id) }} kWh）<template v-if="i < draft.readingIds.length - 1"> + </template>
            </span>
          </td>
          <td>
            <span class="ok-text">已与抄录记录核对一致</span>
          </td>
        </tr>
        <tr v-if="!meterDrafts.length">
          <td colspan="6" class="empty-state">还没有复核通过的上网关口电量；请到「电量计量」复核抄录</td>
        </tr>
      </tbody>
    </table>
    <p class="muted-note">说明：下网关口 / 站用变关口电量不进结算；历史老单据按原单留档，默认不重复挂待核算。</p>

    <h3 class="block-title">结算单台账（通用登记）</h3>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无发电结算数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条结算单台账记录</span>
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
import { getAllReadings, getSettlementDrafts } from '@/data/meter/service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('settlement')
const columns = ['结算单号', '结算周期', '上网电量', '结算电价', '补贴金额', '结算金额', '开票状态', '结算状态']
const actions = ['发起核算', '确认结算', '登记开票']
const statuses = ['待核算', '核算中', '已确认', '已开票']
const stats = [{ label: '待核算结算单', value: 0 }, { label: '本月上网电量', value: 0 }, { label: '本月结算金额', value: 0 }]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const meterDrafts = computed(() => getSettlementDrafts())
const readingEnergy = (id: number) => getAllReadings().find((item) => item.id === id)?.energy ?? '—'

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发电结算列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.block-title { margin: 16px 0 8px; font-size: 15px; }
.muted-note { font-size: 12px; color: var(--muted); margin: 6px 0 14px; }
.chip { white-space: nowrap; }
.ok-text { color: #067647; }
</style>
