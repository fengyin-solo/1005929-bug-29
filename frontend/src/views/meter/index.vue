<template>
  <section class="page" data-module="meter">
    <header class="page-head">
      <div>
        <h2>电量计量管理</h2>
        <p class="page-desc">
          关口计量表抄录一次落定：本期读数、上期读数、倍率、本期电量与计量状态同一事务写入，
          写不成功整笔退回；复核后读数归档，下一回抄录只读不覆盖。
        </p>
      </div>
      <div class="head-tools">
        <label class="role-pick">
          <span>当前岗位（演示倍率权限）</span>
          <select :value="session.operator" @change="switchRole">
            <option v-for="role in SESSION_ROLES" :key="role.name" :value="role.name">{{ role.name }}</option>
          </select>
        </label>
        <button class="btn" type="button" :class="{ 'fault-on': faultOn }" @click="toggleFault">
          {{ faultOn ? '关闭取数故障' : '模拟取数故障' }}
        </button>
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

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>计量点编号 / 方向</span>
        <input v-model="keyword" placeholder="按编号或方向检索" />
      </label>
      <button class="btn" type="submit">查询</button>
    </form>

    <div class="table-toolbar">
      <button class="btn" type="button" @click="pickImportFile">批量灌入老读数（CSV）</button>
      <input ref="triggerImport" hidden type="file" accept=".csv,text/csv" @change="onFilePicked" />
      <span class="toolbar-hint">表头：计量点编号,周期,抄表日期,本期读数。缺哪个计量点会点名，整批不合规整笔退回。</span>
    </div>
    <p v-if="importMessage" class="import-message" :class="importOk ? 'ok-text' : 'error-text'">
      {{ importMessage }}
      <button v-if="importAllowMissing" class="link" type="button" @click="confirmImportAnyway">确认缺失仍要导入</button>
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th>计量点编号</th>
          <th>计量方向</th>
          <th>所属电站</th>
          <th>当前倍率</th>
          <th>最近周期</th>
          <th>上期读数</th>
          <th>本期读数</th>
          <th>本期电量(kWh)</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="row.id">
          <td>{{ row.code }}</td>
          <td>{{ row.direction }}</td>
          <td>{{ row.stationName }}</td>
          <td>{{ row.ratio }}</td>
          <td>{{ row.lastPeriod }}</td>
          <td>{{ row.lastPrevious ?? '—' }}</td>
          <td>{{ row.lastCurrent ?? '—' }}</td>
          <td>{{ row.lastEnergy ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row.id)">详情/抄录</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="10" class="empty-state">暂无关口计量表数据</td>
        </tr>
      </tbody>
    </table>

    <!-- 详情面板：与导出/打印同源，页面看到什么文件里就是什么 -->
    <div v-if="selected" class="detail-panel">
      <div class="detail-head">
        <h3>关口计量表详情 · {{ selected.code }}</h3>
        <button class="btn ghost" type="button" @click="selected = null">收起面板</button>
      </div>

      <section class="detail-section">
        <h4>表计档案</h4>
        <table class="data-table kv-table">
          <tbody>
            <tr v-for="pair in (snapshot?.infoRows ?? [])" :key="pair[0]">
              <th>{{ pair[0] }}</th>
              <td>{{ pair[1] }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="detail-section">
        <h4>本期抄录（一次落定）</h4>
        <form class="reading-form" @submit.prevent="doSubmit">
          <label>
            <span>周期</span>
            <input v-model="form.period" placeholder="YYYY-MM" />
          </label>
          <label>
            <span>抄表日期</span>
            <input v-model="form.readDate" placeholder="YYYY-MM-DD" />
          </label>
          <label>
            <span>本期读数</span>
            <input v-model.number="form.current" type="number" step="0.01" />
          </label>
          <label class="check-line">
            <input v-model="form.resetMeter" type="checkbox" />
            <span>换表倒行，本期按新表起算</span>
          </label>
          <button class="btn" type="button" :disabled="fetching" @click="doFetch">
            {{ fetching ? '取数中…' : '采集取数' }}
          </button>
          <button class="btn primary" type="submit" :disabled="submitting">
            {{ submitting ? '提交中…' : '提交抄录' }}
          </button>
          <span class="preview">
            拟用上期读数 <strong>{{ expectedPrevious ?? '—' }}</strong>
            · 适用倍率 <strong>{{ expectedRatio ?? '—' }}</strong>
            · 预计本期电量 <strong>{{ energyPreview ?? '—' }}</strong> kWh
          </span>
        </form>
      </section>

      <section class="detail-section">
        <h4>倍率管理（仅本电站计量专责可改；历史从投运时间补起）</h4>
        <form class="reading-form" @submit.prevent="doChangeRatio">
          <label>
            <span>新生效日期</span>
            <input v-model="ratioForm.effectiveDate" placeholder="YYYY-MM-DD" />
          </label>
          <label>
            <span>新倍率</span>
            <input v-model.number="ratioForm.ratio" type="number" step="1" min="1" />
          </label>
          <label class="reason-line">
            <span>变更事由</span>
            <input v-model="ratioForm.reason" placeholder="如：互感器更换" />
          </label>
          <button class="btn primary" type="submit">变更并重算未归档电量</button>
        </form>
        <table class="data-table compact">
          <thead>
            <tr><th>生效日期</th><th>倍率</th><th>操作人</th><th>事由</th></tr>
          </thead>
          <tbody>
            <tr v-for="(item, i) in ratioHistoryDesc" :key="`${item.effectiveDate}-${i}`">
              <td>{{ item.effectiveDate }}</td>
              <td>{{ item.ratio }}</td>
              <td>{{ item.operator }}</td>
              <td>{{ item.reason }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="detail-section">
        <h4>导出 / 打印（与本面板同源；中断从断点续打，不留半包）</h4>
        <div class="job-actions">
          <button class="btn" type="button" @click="startJob('下载')">生成下载任务</button>
          <button class="btn" type="button" @click="startJob('打印')">生成打印任务</button>
        </div>
        <table v-if="jobs.length" class="data-table compact">
          <thead>
            <tr><th>任务</th><th>文件名</th><th>进度</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="job in jobs" :key="job.id">
              <td>{{ job.kind }}</td>
              <td>{{ job.filename }}</td>
              <td>
                <div class="progress"><div class="progress-bar" :style="{ width: `${percent(job)}%` }" /></div>
                {{ job.cursor }}/{{ job.total }} 块（{{ percent(job) }}%）
              </td>
              <td>{{ job.status }}</td>
              <td class="row-actions">
                <button class="link" type="button" @click="pump(job, 1)">打一块</button>
                <button class="link" type="button" @click="pump(job, 999)">一次打完</button>
                <button class="link danger" type="button" @click="pump(job, 1, job.cursor)">模拟此处中断</button>
                <button v-if="job.status === '已中断'" class="link" type="button" @click="pump(job, 999)">从断点续打</button>
                <button v-if="job.status === '已完成' && job.kind === '下载'" class="link" type="button" @click="finishDownload(job)">下载文件</button>
                <button v-if="job.status === '已完成' && job.kind === '打印'" class="link" type="button" @click="finishPrint(job)">打印</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="detail-section">
        <h4>抄录台账（复核确认后的读数已归档，不再被覆盖）</h4>
        <table class="data-table compact">
          <thead>
            <tr>
              <th>周期</th><th>抄表日期</th><th>上期读数</th><th>本期读数</th><th>倍率</th>
              <th>本期电量(kWh)</th><th>状态</th><th>来源</th><th>结算单号</th><th>抄表人</th><th>复核人</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in detailReadings" :key="item.id">
              <td>{{ item.period }}</td>
              <td>{{ item.readDate }}</td>
              <td>{{ item.previous }}</td>
              <td>{{ item.current }}</td>
              <td>{{ item.ratio }}</td>
              <td>{{ item.energy }}</td>
              <td>{{ item.status }}</td>
              <td>{{ item.legacy ? '历史老单据' : '本期抄录' }}</td>
              <td>{{ item.settlementNo ?? '—' }}</td>
              <td>{{ item.submittedBy }}</td>
              <td>{{ item.reviewedBy ?? '—' }}</td>
              <td class="row-actions">
                <button v-if="item.status === '已抄录'" class="link" type="button" @click="doSendReview(item.id)">提交复核</button>
                <button v-if="item.status === '待复核'" class="link" type="button" @click="doReview(item.id, true)">复核通过</button>
                <button v-if="item.status === '待复核'" class="link danger" type="button" @click="doReview(item.id, false)">驳回</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <p v-if="detailMessage" class="detail-message" :class="detailOk ? 'ok-text' : 'error-text'">{{ detailMessage }}</p>
    </div>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 只关口计量表</span>
      <span v-if="listMessage" class="error-text">{{ listMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { SESSION_ROLES, useSessionStore } from '@/stores/session'
import {
  changeRatio,
  createExportJob,
  exportJobContent,
  fetchRemoteReading,
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
  setFetchFaultInjection,
  submitReading,
  type Actor,
  type MeterListItem,
} from '@/data/meter/service'
import { isValidDate, isValidPeriod, jobPercent, ratioOnDate, resolvePrevious } from '@/data/meter/engine'
import type { ExportJob, ReadingRecord } from '@/data/meter/types'

const session = useSessionStore()
const actor = computed<Actor>(() => ({ name: session.operator, role: session.role, stationId: session.stationId }))

const rows = ref<MeterListItem[]>([])
const keyword = ref('')
const listMessage = ref('')
const selectedId = ref<number | null>(null)
const detailReadings = ref<ReadingRecord[]>([])
const jobs = ref<ExportJob[]>([])
const fetching = ref(false)
const submitting = ref(false)
/** 幂等令牌在面板打开时生成、提交成功后轮换：连点两回只发同一笔，下一次抄录才换新令牌。 */
let submitToken = ''

const statusSummary = computed(() => {
  const statuses = ['待抄表', '已抄录', '待复核', '已确认']
  return statuses.map((status) => ({ status, count: rows.value.filter((row) => row.status === status).length }))
})

const stats = computed(() => [
  { label: '关口计量表', value: rows.value.length },
  { label: '待复核读数', value: rows.value.filter((row) => row.status === '待复核').length },
  { label: '待抄表计量点', value: rows.value.filter((row) => row.status === '待抄表').length },
  { label: '结算待核算单', value: getSettlementDrafts().length },
])

const filteredRows = computed(() => {
  const key = keyword.value.trim()
  if (!key) {
    return rows.value
  }
  return rows.value.filter(
    (row) => row.code.includes(key) || row.direction.includes(key) || row.stationName.includes(key),
  )
})

const selected = computed(() => rows.value.find((row) => row.id === selectedId.value) ?? null)
const snapshot = computed(() => (selectedId.value === null ? null : getDetailSnapshot(selectedId.value)))
const ratioHistoryDesc = computed(() =>
  snapshot.value
    ? [...snapshot.value.ratioRows].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
    : [],
)

const thisMonth = () => new Date().toISOString().slice(0, 7)
const today = () => new Date().toISOString().slice(0, 10)

const form = reactive({ period: thisMonth(), readDate: today(), current: null as number | null, resetMeter: false })
const ratioForm = reactive({ effectiveDate: today(), ratio: null as number | null, reason: '' })

const detailMessage = ref('')
const detailOk = ref(true)
const importMessage = ref('')
const importOk = ref(false)
const importAllowMissing = ref(false)
let pendingImportText = ''
const triggerImport = ref<HTMLInputElement | null>(null)
const faultOn = ref(false)

const expectedPrevious = computed(() => {
  if (selectedId.value === null || !isValidPeriod(form.period)) {
    return null
  }
  const meter = selected.value
  if (!meter) {
    return null
  }
  return resolvePrevious(getAllReadings(), meter, form.period)
})

const expectedRatio = computed(() => {
  const meter = selected.value
  if (!meter || !isValidDate(form.readDate)) {
    return null
  }
  return ratioOnDate(meter, form.readDate)
})

const energyPreview = computed(() => {
  if (form.current === null || expectedPrevious.value === null || expectedRatio.value === null) {
    return null
  }
  const base = form.resetMeter ? 0 : expectedPrevious.value
  return Math.round(((form.current - base) * expectedRatio.value + Number.EPSILON) * 100) / 100
})

function reload() {
  listMessage.value = ''
  try {
    rows.value = getMeterList()
    if (selectedId.value !== null) {
      refreshDetail()
    }
  } catch (error) {
    listMessage.value = error instanceof Error ? error.message : '电量计量列表读取失败'
  }
}

function switchRole(event: Event) {
  const name = (event.target as HTMLSelectElement).value
  const role = SESSION_ROLES.find((item) => item.name === name)
  if (role) {
    session.applyRole(role)
  }
}

function toggleFault() {
  faultOn.value = !faultOn.value
  setFetchFaultInjection(faultOn.value)
}

function openDetail(id: number) {
  selectedId.value = id
  form.period = thisMonth()
  form.readDate = today()
  form.current = null
  form.resetMeter = false
  ratioForm.effectiveDate = today()
  ratioForm.ratio = null
  ratioForm.reason = ''
  detailMessage.value = ''
  submitToken = makeToken()
  refreshDetail()
}

function refreshDetail() {
  if (selectedId.value === null) {
    return
  }
  detailReadings.value = getReadings(selectedId.value)
  jobs.value = listExportJobs(selectedId.value)
}

function flash(message: string, ok = true) {
  detailMessage.value = message
  detailOk.value = ok
}

function makeToken() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `token-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function doFetch() {
  if (selectedId.value === null) {
    return
  }
  fetching.value = true
  const result = await fetchRemoteReading(selectedId.value)
  fetching.value = false
  if (result.ok && typeof result.value === 'number') {
    // 取不到数时不会走到这里，输入框原值保留，绝不清零
    form.current = result.value
    flash(result.message, true)
  } else {
    flash(result.message, false)
  }
}

function doSubmit() {
  if (selectedId.value === null || form.current === null) {
    flash('请填写本期读数（或先采集取数）', false)
    return
  }
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    const result = submitReading({
      meterId: selectedId.value,
      period: form.period,
      readDate: form.readDate,
      current: form.current,
      operator: actor.value.name,
      token: submitToken,
      resetMeter: form.resetMeter,
    })
    flash(result.message, result.ok)
    if (result.ok) {
      form.current = null
      submitToken = makeToken()
      reload()
    }
  } finally {
    submitting.value = false
  }
}

function doSendReview(id: number) {
  const result = sendForReview(id, actor.value)
  flash(result.message, result.ok)
  reload()
}

function doReview(id: number, pass: boolean) {
  const result = reviewReading({ readingId: id, pass, reviewer: actor.value.name }, actor.value)
  flash(result.message, result.ok)
  reload()
}

function doChangeRatio() {
  if (selectedId.value === null || ratioForm.ratio === null) {
    flash('请填写新倍率', false)
    return
  }
  const result = changeRatio(
    {
      meterId: selectedId.value,
      ratio: ratioForm.ratio,
      effectiveDate: ratioForm.effectiveDate,
      operator: actor.value.name,
      reason: ratioForm.reason,
    },
    actor.value,
  )
  flash(result.message, result.ok)
  if (result.ok) {
    ratioForm.ratio = null
    ratioForm.reason = ''
  }
  reload()
}

function pickImportFile() {
  triggerImport.value?.click()
}

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    pendingImportText = String(reader.result ?? '')
    importAllowMissing.value = false
    runImport(false)
  }
  reader.readAsText(file, 'utf-8')
  input.value = ''
}

function runImport(allowMissing: boolean) {
  const result = importReadings(pendingImportText, actor.value, allowMissing)
  importOk.value = result.ok
  importMessage.value = result.message
  importAllowMissing.value = !result.ok && result.missingPointCodes.length > 0 && result.unknownPointRows.length === 0
  if (result.ok) {
    pendingImportText = ''
    reload()
  }
}

function confirmImportAnyway() {
  runImport(true)
}

function startJob(kind: '下载' | '打印') {
  if (selectedId.value === null) {
    return
  }
  const job = createExportJob(selectedId.value, kind)
  refreshDetail()
  flash(`已创建${kind}任务：${job.filename}，共 ${job.total} 块`, true)
}

function pump(job: ExportJob, steps: number, failAtCursor?: number) {
  const result = pumpExportJob(job.id, { steps, failAtCursor })
  flash(result.message, result.ok)
  refreshDetail()
}

function percent(job: ExportJob) {
  return jobPercent(job)
}

function finishDownload(job: ExportJob) {
  const result = exportJobContent(job.id)
  if (!result.ok || !result.content) {
    flash(result.message, false)
    return
  }
  const blob = new Blob([result.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename ?? 'export.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  flash('下载文件即详情面板同源快照', true)
}

function finishPrint(job: ExportJob) {
  const result = exportJobContent(job.id)
  if (!result.ok || !result.content) {
    flash(result.message, false)
    return
  }
  const win = window.open('', '_blank')
  if (!win) {
    flash('浏览器拦截了打印窗口，请允许弹窗后重试', false)
    return
  }
  win.document.write(`<pre style="font-family:monospace;white-space:pre-wrap;">${escapeHtml(result.content)}</pre>`)
  win.document.close()
  win.focus()
  win.print()
}

function escapeHtml(text: string) {
  return text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] as string)
}

onMounted(reload)
</script>

<style scoped>
.head-tools { display: flex; gap: 10px; align-items: flex-end; }
.role-pick span { display: block; font-size: 12px; color: var(--muted); }
.role-pick select { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.fault-on { border-color: #b42318; color: #b42318; }
.table-toolbar { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
.toolbar-hint { font-size: 12px; color: var(--muted); }
.import-message { white-space: pre-line; font-size: 13px; }
.ok-text { color: #067647; }
.detail-panel { margin-top: 18px; border: 1px solid var(--brand); border-radius: 10px; background: #fff; padding: 14px 16px; }
.detail-head { display: flex; justify-content: space-between; align-items: center; }
.detail-head h3 { margin: 0; }
.detail-section { margin-top: 14px; }
.detail-section h4 { margin: 0 0 8px; font-size: 14px; }
.kv-table th { width: 160px; background: #f8fafc; }
.reading-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-bottom: 10px; }
.reading-form label span { display: block; font-size: 12px; color: var(--muted); }
.reading-form input { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; min-width: 150px; }
.check-line, .check-line span { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
.reason-line input { min-width: 220px; }
.preview { font-size: 12px; color: var(--muted); width: 100%; }
.compact th, .compact td { padding: 6px 8px; font-size: 12px; }
.job-actions { display: flex; gap: 8px; margin-bottom: 8px; }
.progress { width: 120px; height: 8px; background: #eef2f7; border-radius: 999px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
.progress-bar { height: 100%; background: var(--brand); }
.link.danger { color: #b42318; }
.detail-message { white-space: pre-line; }
</style>
