<template>
  <section class="page" data-module="meter">
    <header class="page-head">
      <div>
        <h2>电量计量管理</h2>
        <p class="page-desc">
          关口计量表抄录一次落定：本期读数、上期读数与计量状态同笔写入，写不成功整笔退回；复核后上期读数归档冻结，
          结果进发电结算待核算清单。当前身份：<strong>{{ store.profile.name }}（{{ store.profile.role }}/{{ store.profile.stationName }}）</strong>
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreateForFirst">抄录入档</button>
        <button class="btn" type="button" @click="importOpen = true">批量灌档</button>
        <button class="btn" type="button" @click="showPrintQueue = true">打印队列<span v-if="printJobs.length" class="badge">{{ printJobs.length }}</span></button>
        <button class="btn" type="button" @click="exportRows">导出计量清单</button>
        <button class="btn ghost" type="button" @click="resetAll">重置示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="reconcile-strip">
      <div>
        <strong>发电结算 · 待核算清单（复核结果落点）</strong>
        <span class="muted">共 {{ pendingItems.length }} 条，两处本期电量必须一致</span>
      </div>
      <button class="btn" type="button" @click="runReconcile">对账校验</button>
    </div>
    <table v-if="pendingItems.length" class="data-table mini">
      <thead>
        <tr><th>清单项编号</th><th>计量点</th><th>周期</th><th>本期电量(kWh)</th><th>状态</th><th>复核时间</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in pendingItems" :key="item.id">
          <td>{{ item.itemNo }}</td>
          <td>{{ item.pointCode }}</td>
          <td>{{ item.period }}</td>
          <td>{{ item.energy }}</td>
          <td>{{ item.status }}</td>
          <td>{{ formatTime(item.confirmedAt) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="reconcileMessage" :class="reconcileOk ? 'ok-text' : 'error-text'">{{ reconcileMessage }}</p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>计量点编号 / 电站</span>
        <input v-model="keyword" placeholder="按计量点编号或电站检索" />
      </label>
      <label class="filter-item">
        <span>计量状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)" :class="{ active: selectedCode === row['计量点编号'] }">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>
            <span :class="['status-pill', statusClass(String(row.status))]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(String(row['计量点编号']))">详情</button>
            <button class="link" type="button" @click="openCapture(String(row['计量点编号']))">
              {{ row.status === '已驳回' ? '重抄' : '抄录' }}
            </button>
            <button
              class="link"
              type="button"
              :disabled="!canChangeRatio(String(row['电站编号']))"
              :title="canChangeRatio(String(row['电站编号'])) ? '改倍率并重算未确认电量' : '只有本电站的计量专责能改倍率'"
              @click="openRatio(String(row['计量点编号']))"
            >
              改倍率
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的关口计量表</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 个计量点；数据在本机浏览器持久化</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情面板：展示内容与下载/打印走同一份序列化单据 -->
    <div v-if="detailOpen" class="drawer-mask" @click.self="detailOpen = false">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>关口计量表详情 · {{ detail?.point.pointCode }}</h3>
          <button class="btn ghost" type="button" @click="detailOpen = false">关闭</button>
        </header>

        <template v-if="detail">
          <div class="drawer-actions">
            <button class="btn primary" type="button" @click="openCapture(detail.point.pointCode)">
              {{ detail.reading?.status === '已驳回' ? '驳回重抄' : '抄录入档' }}
            </button>
            <button
              class="btn"
              type="button"
              :disabled="!canSubmitReview"
              @click="doSubmitReview"
            >提交复核</button>
            <button class="btn" type="button" :disabled="detail.reading?.status !== '待复核'" @click="doConfirm">确认计量</button>
            <button class="btn danger" type="button" :disabled="detail.reading?.status !== '待复核'" @click="doReject">驳回复核</button>
            <button
              class="btn"
              type="button"
              :disabled="!canChangeRatio(detail.point.stationCode)"
              @click="openRatio(detail.point.pointCode)"
            >改倍率</button>
            <button class="btn" type="button" @click="downloadDocument">下载单据</button>
            <button class="btn" type="button" @click="createPrint">建打印任务</button>
          </div>
          <p v-if="!canChangeRatio(detail.point.stationCode)" class="muted small">
            当前身份不是本电站计量专责，「改倍率」不可用；{{ permissionHint(detail.point.stationCode) }}
          </p>

          <div class="kv-grid">
            <div><span>所属电站</span><b>{{ detail.point.stationName }}</b></div>
            <div><span>计量方向</span><b>{{ detail.point.direction }}</b></div>
            <div><span>表计型号</span><b>{{ detail.point.meterModel }}</b></div>
            <div><span>当前倍率</span><b>{{ detail.point.ratio }}</b></div>
            <div><span>投运日期</span><b>{{ detail.point.commissioningDate }}</b></div>
            <div><span>计量状态</span><b>{{ detail.reading?.status ?? '待抄表' }}</b></div>
          </div>

          <h4 class="block-title">本期抄录（一笔落定）</h4>
          <table v-if="detail.reading" class="data-table mini">
            <tbody>
              <tr><th>结算周期</th><td>{{ detail.reading.period }}</td><th>抄表日期</th><td>{{ detail.reading.readDate }}</td></tr>
              <tr>
                <th>本期读数</th><td>{{ detail.reading.currentReading }}</td>
                <th>上期读数</th><td>{{ detail.reading.previousReading }}（{{ detail.previous?.source ?? '本笔落抄带入' }}）</td>
              </tr>
              <tr>
                <th>生效倍率</th><td>{{ detail.reading.ratio }}</td>
                <th>本期电量</th><td><strong>{{ detail.reading.energy }} kWh</strong></td>
              </tr>
              <tr><th>抄录人</th><td>{{ detail.reading.operator }}</td><th>提交令牌</th><td class="token">{{ detail.reading.requestToken }}</td></tr>
              <tr v-if="detail.reading.rejectReason"><th>驳回原因</th><td colspan="3" class="error-text">{{ detail.reading.rejectReason }}</td></tr>
            </tbody>
          </table>
          <p v-else class="muted">本期尚未抄录。上期读数：{{ detail.previous ? `${detail.previous.reading}（${detail.previous.source}）` : '无归档、无老单据，抄录时需手工录入' }}</p>

          <h4 class="block-title">上期读数归档（复核后留存，不被下一回覆盖）</h4>
          <table class="data-table mini">
            <thead><tr><th>周期</th><th>表底</th><th>倍率</th><th>电量</th><th>版本</th><th>来源</th></tr></thead>
            <tbody>
              <tr v-for="archive in detail.archives" :key="archive.id">
                <td>{{ archive.period }}</td><td>{{ archive.reading }}</td><td>{{ archive.ratio }}</td>
                <td>{{ archive.energy }}</td><td>v{{ archive.version }}</td><td>{{ archive.source }}</td>
              </tr>
              <tr v-if="!detail.archives.length"><td colspan="6" class="empty-state">暂无归档</td></tr>
            </tbody>
          </table>

          <h4 class="block-title">倍率版本（从投运时间补起）</h4>
          <table class="data-table mini">
            <thead><tr><th>生效日期</th><th>倍率</th><th>原因</th><th>操作人</th></tr></thead>
            <tbody>
              <tr v-for="ratio in detail.ratios" :key="ratio.id">
                <td>{{ ratio.effectiveDate }}</td><td>{{ ratio.ratio }}</td><td>{{ ratio.reason }}</td><td>{{ ratio.operator }}</td>
              </tr>
            </tbody>
          </table>

          <h4 class="block-title">单据原文（下载文件与打印送出与此逐行一致） · 指纹 {{ documentHash }}</h4>
          <pre class="doc-lines">{{ documentText }}</pre>
        </template>
      </aside>
    </div>

    <!-- 抄录入档 -->
    <div v-if="captureOpen" class="modal-mask" @click.self="captureOpen = false">
      <div class="modal">
        <h3>抄录入档 · {{ captureForm.pointCode }}</h3>
        <p class="muted small">本期读数、上期读数、倍率、电量、计量状态一笔提交；写不成功整笔退回。重复提交同一令牌只算一次。</p>
        <div class="form-grid">
          <label><span>结算周期</span><input v-model="captureForm.period" placeholder="YYYY-MM" /></label>
          <label><span>抄表日期</span><input v-model="captureForm.readDate" placeholder="YYYY-MM-DD" type="date" /></label>
          <label>
            <span>本期读数（表底）</span>
            <input v-model.number="captureForm.currentReading" type="number" step="0.01" />
          </label>
          <button class="btn" type="button" :disabled="dialing" @click="autoFetch">
            {{ dialing ? `重取中（第 ${dialAttempt} 次）…` : '向表计重取' }}
          </button>
          <label>
            <span>上期读数{{ resolvedPreviousLabel }}</span>
            <input
              :value="captureForm.manualPrevious ?? ''"
              :placeholder="resolvedPreviousPlaceholder"
              type="number"
              step="0.01"
              :disabled="resolvedPrevious !== null"
              @input="onManualPreviousInput"
            />
          </label>
          <div class="hint-box">
            <div>生效倍率：<strong>{{ capturePreview.ratio ?? '—' }}</strong>（写入前校验，从投运日版本取值）</div>
            <div>预计本期电量：<strong>{{ capturePreview.energy ?? '—' }}</strong> kWh =（本期 − 上期）× 倍率</div>
            <div class="token">本次提交令牌：{{ captureForm.requestToken }}</div>
          </div>
        </div>
        <p v-if="captureMessage" :class="captureOk ? 'ok-text' : 'error-text'">{{ captureMessage }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="regenToken">换新令牌</button>
          <button class="btn ghost" type="button" @click="captureOpen = false">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitCapture">
            {{ submitting ? '提交中…' : '一次落定提交' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 改倍率 -->
    <div v-if="ratioOpen" class="modal-mask" @click.self="ratioOpen = false">
      <div class="modal">
        <h3>倍率变更 · {{ ratioForm.pointCode }}</h3>
        <p class="muted small">只有本电站的计量专责可改；写入前校验倍率；保存后自动重算未确认电量，已确认归档冻结不动。</p>
        <div class="form-grid">
          <label><span>新倍率（&gt;0）</span><input v-model.number="ratioForm.ratio" type="number" min="0" step="1" /></label>
          <label><span>生效日期</span><input v-model="ratioForm.effectiveDate" type="date" /></label>
          <label class="wide"><span>变更原因</span><input v-model="ratioForm.reason" placeholder="如：CT 更换后变比调整" /></label>
        </div>
        <p v-if="ratioMessage" :class="ratioOk ? 'ok-text' : 'error-text'">{{ ratioMessage }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="ratioOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitRatio">校验并保存</button>
        </div>
      </div>
    </div>

    <!-- 批量灌档 -->
    <div v-if="importOpen" class="modal-mask wide" @click.self="importOpen = false">
      <div class="modal">
        <h3>历史抄表批量灌档</h3>
        <p class="muted small">
          先全量校验再整批落账：缺计量点、错行都会点名到行，有一行不过整批退回；同一批文件重复提交只算一次。
        </p>
        <div class="modal-actions left">
          <button class="btn" type="button" @click="downloadTemplate">下载模板</button>
          <label class="btn">
            选择 CSV
            <input type="file" accept=".csv,text/csv" hidden @change="onPickFile" />
          </label>
          <span class="muted small">{{ importFileName || '也可以直接把 CSV 文本贴进下面框里' }}</span>
        </div>
        <textarea v-model="importContent" class="import-area" rows="8" placeholder="计量点编号,结算周期,抄表日期,本期读数,倍率,上期读数(留空自动取归档)"></textarea>
        <p v-if="importMessage" :class="importOk ? 'ok-text' : 'error-text'">{{ importMessage }}</p>
        <table v-if="importErrors.length" class="data-table mini error-table">
          <thead><tr><th>行号</th><th>计量点</th><th>问题（整批因此退回，一行未写）</th></tr></thead>
          <tbody>
            <tr v-for="err in importErrors" :key="`${err.row}-${err.pointCode}`">
              <td>第 {{ err.row }} 行</td><td>{{ err.pointCode }}</td><td>{{ err.message }}</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="importOpen = false">关闭</button>
          <button class="btn primary" type="button" @click="submitImport">先校验后灌档</button>
        </div>
      </div>
    </div>

    <!-- 打印队列 -->
    <div v-if="showPrintQueue" class="modal-mask wide" @click.self="showPrintQueue = false">
      <div class="modal">
        <h3>关口表单据打印队列</h3>
        <p class="muted small">
          建任务时冻结单据逐行内容与指纹；逐行送出、逐行落断点，中断后从断点续打，已送行不重打、不留半包。
        </p>
        <div class="modal-actions left">
          <label class="inline-check">
            <input v-model="simulateNextFail" type="checkbox" />
            模拟下一行卡纸/断连（验证中断续打）
          </label>
        </div>
        <table class="data-table mini">
          <thead><tr><th>任务号</th><th>计量点</th><th>周期</th><th>进度</th><th>状态</th><th>单据指纹</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="job in printJobs" :key="job.id">
              <td>{{ job.jobNo }}</td>
              <td>{{ job.pointCode }}</td>
              <td>{{ job.period || '—' }}</td>
              <td>
                <div class="progress"><div class="progress-bar" :style="{ width: `${(job.deliveredLines / job.totalLines) * 100}%` }"></div></div>
                <span class="small">{{ job.deliveredLines }}/{{ job.totalLines }} 行</span>
              </td>
              <td>
                <span :class="['status-pill', printStatusClass(job.status)]">{{ job.status }}</span>
                <span v-if="jobDrifting(job.id)" class="error-text small"> 单据已变更（续打仍按冻结快照）</span>
              </td>
              <td class="token">{{ job.contentHash }}</td>
              <td class="row-actions">
                <button class="link" type="button" :disabled="job.status === '已打完'" @click="advanceJob(job.id)">
                  {{ job.deliveredLines === 0 ? '开始打印' : job.status === '已中断' ? '断点续打' : '继续送出' }}
                </button>
                <button class="link" type="button" :disabled="job.status === '已打完'" @click="abortJob(job.id)">中断</button>
              </td>
            </tr>
            <tr v-if="!printJobs.length"><td colspan="7" class="empty-state">暂无打印任务，去详情面板「建打印任务」</td></tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="showPrintQueue = false">完成</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  advancePrintJob,
  buildMeterDocument,
  changeRatio,
  confirmReading,
  createPrintJob,
  exportMeterDocument,
  fetchMeterReading,
  importHistoricalReadings,
  importTemplate,
  latestPeriod,
  listPrintJobs,
  listSettlementPending,
  printJobDrift,
  reconcilePending,
  rejectReading,
  requestAbortPrint,
  resetMeterDomain,
  serializeMeterDocument,
  setPrintDriver,
  submitForReview,
  submitReading,
} from '@/api/meter-service'
import type { MeterDetail } from '@/api/meter-service'
import type { EntryRow, PrintJob, SettlementItem } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const meta = moduleMeta('meter')
const columns = ['计量点编号', '所属电站', '计量方向', '倍率', '结算周期', '抄表日期', '本期读数', '上期读数', '本期电量']
const statuses = ['待抄表', '已抄录', '待复核', '已确认', '已驳回']

const rows = ref<EntryRow[]>([])
const keyword = ref('')
const statusFilter = ref('')
const errorMessage = ref('')

const pendingItems = ref<SettlementItem[]>([])
const reconcileMessage = ref('')
const reconcileOk = ref(false)

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length })),
)
const stats = computed(() => [
  { label: '计量点总数', value: rows.value.length },
  { label: '待抄表', value: rows.value.filter((row) => row.status === '待抄表').length },
  { label: '待复核读数', value: rows.value.filter((row) => row.status === '待复核').length },
  { label: '结算待核算项', value: pendingItems.value.length },
])
const filteredRows = computed(() =>
  rows.value.filter((row) => {
    const kw = keyword.value.trim()
    const hitKw = !kw || String(row['计量点编号']).includes(kw) || String(row['所属电站']).includes(kw)
    const hitStatus = !statusFilter.value || String(row.status) === statusFilter.value
    return hitKw && hitStatus
  }),
)

function statusClass(status: string): string {
  if (status === '已确认') return 'ok'
  if (status === '待复核' || status === '已抄录') return 'warn'
  if (status === '已驳回') return 'bad'
  return ''
}
function printStatusClass(status: string): string {
  if (status === '已打完') return 'ok'
  if (status === '已中断') return 'bad'
  return 'warn'
}
function formatTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = listEntries(meta.key).items
    pendingItems.value = listSettlementPending()
    printJobs.value = listPrintJobs()
    if (selectedCode.value) {
      refreshDetail(selectedCode.value)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '电量计量列表读取失败'
  }
}

function resetFilters() {
  keyword.value = ''
  statusFilter.value = ''
}

function exportRows() {
  downloadEntries(meta.key)
}

function resetAll() {
  resetMeterDomain()
  selectedCode.value = ''
  detailOpen.value = false
  reload()
  errorMessage.value = '电量计量领域数据已重置为示例数据'
}

function openCreateForFirst() {
  const first = filteredRows.value[0]
  if (first) {
    openCapture(String(first['计量点编号']))
  }
}

// ── 权限 ──────────────────────────────────────────────────────────────────

function canChangeRatio(stationCode: string): boolean {
  const profile = store.profile
  return profile.role === '计量专责' && profile.stationCode === stationCode
}
function permissionHint(stationCode: string): string {
  const profile = store.profile
  if (profile.role !== '计量专责') {
    return `当前岗位是「${profile.role}」，仅计量专责可改倍率`
  }
  return `当前归属 ${profile.stationName}，跨电站不能改 ${stationCode} 的倍率`
}

// ── 详情面板 ────────────────────────────────────────────────────────────────

const detailOpen = ref(false)
const selectedCode = ref('')
const detail = ref<MeterDetail | null>(null)

function openDetail(pointCode: string) {
  selectedCode.value = pointCode
  refreshDetail(pointCode)
  detailOpen.value = true
}
function refreshDetail(pointCode: string) {
  detail.value = buildMeterDocument(pointCode)
}

const canSubmitReview = computed(() => {
  const status = detail.value?.reading?.status
  const point = detail.value?.point
  if (!point || (status !== '已抄录' && status !== '已驳回')) {
    return false
  }
  const profile = store.profile
  return profile.role === '值班管理员' || !profile.stationCode || profile.stationCode === point.stationCode
})

function doSubmitReview() {
  if (!detail.value?.reading) {
    return
  }
  const result = submitForReview({
    pointCode: detail.value.point.pointCode,
    period: detail.value.reading.period,
    operator: store.profile,
  })
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function doConfirm() {
  if (!detail.value?.reading) {
    return
  }
  const result = confirmReading({
    pointCode: detail.value.point.pointCode,
    period: detail.value.reading.period,
    operator: store.profile,
  })
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function doReject() {
  if (!detail.value?.reading) {
    return
  }
  const reason = window.prompt('请填写驳回原因（驳回后可重抄，待核算项同步移除）')
  if (reason === null) {
    return
  }
  const result = rejectReading({
    pointCode: detail.value.point.pointCode,
    period: detail.value.reading.period,
    reason,
    operator: store.profile,
  })
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

const documentPayload = computed(() => {
  if (!detail.value) {
    return { text: '', hash: '' }
  }
  const doc = serializeMeterDocument(detail.value)
  return { text: doc.lines.join('\n'), hash: doc.hash }
})
const documentText = computed(() => documentPayload.value.text)
const documentHash = computed(() => documentPayload.value.hash)

function download(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function downloadDocument() {
  if (!detail.value) {
    return
  }
  const doc = exportMeterDocument(detail.value.point.pointCode, detail.value.reading?.period)
  if (doc) {
    download(doc.filename, doc.content)
  }
}

// ── 抄录入档 ─────────────────────────────────────────────────────────────────

const captureOpen = ref(false)
const submitting = ref(false)
const dialing = ref(false)
const dialAttempt = ref(0)
const captureMessage = ref('')
const captureOk = ref(false)
const captureForm = ref({
  pointCode: '',
  period: '',
  readDate: '',
  currentReading: null as number | null,
  manualPrevious: null as number | null,
  requestToken: '',
})

function newToken() {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function suggestedPeriod(pointCode: string): string {
  const d = buildMeterDocument(pointCode)
  if (d?.reading && d.reading.status !== '已确认') {
    return d.reading.period
  }
  const latest = latestPeriod(pointCode)
  if (d?.reading?.status === '已确认' && d.reading.period === latest) {
    const [year, month] = latest.split('-').map(Number)
    const date = new Date(year, month, 1)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  }
  return latest
}

function periodEndDate(period: string): string {
  const [year, month] = period.split('-').map(Number)
  if (!year || !month) {
    return ''
  }
  return new Date(year, month, 0).toISOString().slice(0, 10)
}

function openCapture(pointCode: string) {
  const period = suggestedPeriod(pointCode)
  captureForm.value = {
    pointCode,
    period,
    readDate: periodEndDate(period),
    currentReading: null,
    manualPrevious: null,
    requestToken: newToken(),
  }
  captureMessage.value = ''
  captureOpen.value = true
}

function regenToken() {
  captureForm.value.requestToken = newToken()
}

const resolvedPrevious = computed<{ reading: number; source: string } | null>(() => {
  if (!captureForm.value.pointCode || !/^\d{4}-\d{2}$/.test(captureForm.value.period)) {
    return null
  }
  return buildMeterDocument(captureForm.value.pointCode, captureForm.value.period)?.previous ?? null
})
const resolvedPreviousLabel = computed(() =>
  resolvedPrevious.value ? `（自动取：${resolvedPrevious.value.source}）` : '（无归档，需手工录入）',
)
const resolvedPreviousPlaceholder = computed(() =>
  resolvedPrevious.value ? String(resolvedPrevious.value.reading) : '请录入上期表底，取不到数不会填 0',
)

function onManualPreviousInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  captureForm.value.manualPrevious = value === '' ? null : Number(value)
}

const capturePreview = computed(() => {
  const point = buildMeterDocument(captureForm.value.pointCode, captureForm.value.period)?.point
  const current = captureForm.value.currentReading
  const previous = resolvedPrevious.value?.reading ?? captureForm.value.manualPrevious
  if (!point || current == null || previous == null) {
    return { ratio: point?.ratio, energy: null }
  }
  return { ratio: point.ratio, energy: Math.max(0, Math.round((current - previous) * point.ratio)) }
})

async function autoFetch() {
  dialing.value = true
  captureMessage.value = ''
  let attempts = 0
  for (let i = 0; i < 3; i += 1) {
    dialAttempt.value = i + 1
    attempts = i + 1
    const result = await fetchMeterReading(captureForm.value.pointCode, 1)
    if (result.ok && result.data) {
      captureForm.value.currentReading = Number(result.data.reading.toFixed(2))
      captureMessage.value = `第 ${attempts} 次取数成功，读数 ${captureForm.value.currentReading}（取不到数时只重取、不清零）`
      captureOk.value = true
      dialing.value = false
      return
    }
    captureMessage.value = result.message
    captureOk.value = false
  }
  dialing.value = false
}

function submitCapture() {
  captureMessage.value = ''
  const form = captureForm.value
  if (form.currentReading == null) {
    captureOk.value = false
    captureMessage.value = '请先录入或重取本期读数'
    return
  }
  submitting.value = true
  const result = submitReading({
    pointCode: form.pointCode,
    period: form.period,
    readDate: form.readDate,
    currentReading: form.currentReading,
    manualPrevious: resolvedPrevious.value === null ? form.manualPrevious ?? undefined : undefined,
    operator: store.profile,
    requestToken: form.requestToken,
  })
  submitting.value = false
  captureOk.value = result.ok
  captureMessage.value = result.message
  if (result.ok) {
    reload()
    setTimeout(() => {
      captureOpen.value = false
    }, 600)
  }
}

// ── 改倍率 ─────────────────────────────────────────────────────────────────

const ratioOpen = ref(false)
const ratioMessage = ref('')
const ratioOk = ref(false)
const ratioForm = ref({ pointCode: '', ratio: null as number | null, effectiveDate: '', reason: '' })

function openRatio(pointCode: string) {
  const point = buildMeterDocument(pointCode)?.point
  if (!point) {
    return
  }
  if (!canChangeRatio(point.stationCode)) {
    errorMessage.value = permissionHint(point.stationCode)
    return
  }
  ratioForm.value = {
    pointCode,
    ratio: point.ratio,
    effectiveDate: new Date().toISOString().slice(0, 10),
    reason: '',
  }
  ratioMessage.value = ''
  ratioOpen.value = true
}

function submitRatio() {
  const form = ratioForm.value
  if (form.ratio == null) {
    ratioOk.value = false
    ratioMessage.value = '请填写新倍率'
    return
  }
  const result = changeRatio({
    pointCode: form.pointCode,
    ratio: form.ratio,
    effectiveDate: form.effectiveDate,
    reason: form.reason,
    operator: store.profile,
  })
  ratioOk.value = result.ok
  ratioMessage.value = result.message
  if (result.ok) {
    reload()
  }
}

// ── 批量灌档 ─────────────────────────────────────────────────────────────────

const importOpen = ref(false)
const importContent = ref('')
const importFileName = ref('')
const importMessage = ref('')
const importOk = ref(false)
const importErrors = ref<{ row: number; pointCode: string; message: string }[]>([])

function downloadTemplate() {
  const template = importTemplate()
  download(template.filename, template.content)
}

function onPickFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) {
    return
  }
  importFileName.value = file.name
  const reader = new FileReader()
  reader.onload = () => {
    importContent.value = String(reader.result ?? '')
  }
  reader.readAsText(file, 'utf-8')
}

function submitImport() {
  importMessage.value = ''
  importErrors.value = []
  const result = importHistoricalReadings(importContent.value, store.profile)
  importOk.value = result.ok
  importMessage.value = result.message
  importErrors.value = result.data?.errors ?? []
  if (result.ok) {
    reload()
  }
}

// ── 打印队列 ─────────────────────────────────────────────────────────────────

const showPrintQueue = ref(false)
const printJobs = ref<PrintJob[]>([])
const simulateNextFail = ref(false)

function installPrintDriver() {
  setPrintDriver(() => {
    if (simulateNextFail.value) {
      simulateNextFail.value = false
      return false
    }
    return true
  })
}

function createPrint() {
  if (!detail.value) {
    return
  }
  const result = createPrintJob(detail.value.point.pointCode, store.profile)
  errorMessage.value = result.ok ? '' : result.message
  if (result.ok) {
    printJobs.value = listPrintJobs()
    showPrintQueue.value = true
  }
}

function advanceJob(jobId: number) {
  const result = advancePrintJob(jobId, 6)
  errorMessage.value = result.ok ? '' : result.message
  printJobs.value = listPrintJobs()
}

function abortJob(jobId: number) {
  requestAbortPrint(jobId)
  const result = advancePrintJob(jobId, 6)
  errorMessage.value = result.ok ? result.message : result.message
  printJobs.value = listPrintJobs()
}

function jobDrifting(jobId: number): boolean {
  const job = printJobs.value.find((item) => item.id === jobId)
  return job ? printJobDrift(job).drifted : false
}

// ── 对账 ─────────────────────────────────────────────────────────────────────

function runReconcile() {
  const mismatches = reconcilePending()
  reconcileOk.value = mismatches.length === 0
  reconcileMessage.value = mismatches.length
    ? `发现 ${mismatches.length} 处不一致：${mismatches.map((m) => `${m.itemNo} 清单 ${m.actual} / 抄表 ${m.expected}`).join('；')}`
    : `对账通过：待核算清单 ${pendingItems.value.length} 项的本期电量与抄表记录全部一致`
}

onMounted(() => {
  installPrintDriver()
  reload()
})
</script>

<style scoped>
.badge {
  display: inline-block;
  margin-left: 4px;
  background: #b42318;
  color: #fff;
  border-radius: 999px;
  font-size: 11px;
  padding: 0 6px;
}
.mini th, .mini td { padding: 5px 8px; font-size: 12px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.ok-text { color: #067647; }
.token { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--muted); }
tr.active { background: #eef5ff; }
.status-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; background: #e2e8f0; }
.status-pill.ok { background: #d1fadf; color: #067647; }
.status-pill.warn { background: #fef0c7; color: #b54708; }
.status-pill.bad { background: #fee4e2; color: #b42318; }
.reconcile-strip {
  display: flex; justify-content: space-between; align-items: center;
  background: #fff; border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 12px; margin-bottom: 8px;
}
.drawer-mask, .modal-mask {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
  display: flex; justify-content: flex-end; z-index: 50;
}
.modal-mask { justify-content: center; align-items: flex-start; padding-top: 48px; }
.modal-mask.wide .modal { width: 760px; }
.drawer {
  width: 720px; max-width: 92vw; height: 100%; overflow-y: auto;
  background: #fff; padding: 16px 20px; box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
}
.drawer-head { display: flex; justify-content: space-between; align-items: center; }
.drawer-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.block-title { margin: 18px 0 6px; font-size: 14px; border-left: 3px solid var(--brand); padding-left: 8px; }
.kv-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0; }
.kv-grid div { background: #f8fafc; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.kv-grid span { display: block; color: var(--muted); font-size: 12px; }
.doc-lines {
  background: #0f172a; color: #dbeafe; border-radius: 8px; padding: 10px;
  font-size: 11px; line-height: 1.5; max-height: 260px; overflow: auto; white-space: pre-wrap;
}
.modal {
  background: #fff; border-radius: 10px; padding: 18px 20px; width: 520px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.2);
}
.modal h3 { margin: 0 0 8px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
.form-grid label span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.form-grid input, .form-grid select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.form-grid label.wide { grid-column: 1 / -1; }
.hint-box { grid-column: 1 / -1; background: #f8fafc; border: 1px dashed var(--border); border-radius: 6px; padding: 8px; font-size: 12px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.modal-actions.left { justify-content: flex-start; }
.import-area { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.error-table td { color: #b42318; }
.inline-check { font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.progress { width: 120px; height: 8px; background: #e2e8f0; border-radius: 999px; overflow: hidden; margin-bottom: 2px; }
.progress-bar { height: 100%; background: var(--brand); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
