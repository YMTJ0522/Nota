<script setup lang="ts">
/**
 * 中间那一列的「回收站」视图。
 *
 * 删掉的笔记（进工作区的 `.nota/trash/`），能原路恢复——
 * 删之前在哪个目录就回哪个目录，因为删除时把相对路径一并存了下来。
 *
 * 和「附件库」同在中间这一列，但是两个各自独立的视图，不共用一个页签组：
 * 一个处理素材、一个处理被删的笔记，没有共同的上下文，硬凑一起只会点错。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Check,
  FileText,
  Folder,
  History as HistoryIcon,
  ListChecks,
  RotateCcw,
  Square,
  StickyNote,
  Trash2,
} from 'lucide-vue-next'
import { store, touchStickies } from '@/store'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import LibContextMenu, { type LibMenuItem } from '@/components/LibContextMenu.vue'

interface TrashItem {
  key: string
  rel: string
  name: string
  deletedAt: number
  size: number
  isDir?: boolean
  /** 便签的条目。它和工作区无关（便签本来就独立于库），按 key 前缀分流 */
  isSticky?: boolean
}

const items = ref<TrashItem[]>([])
const loading = ref(false)

const root = computed(() => store.state.root ?? '')

/**
 * 两处来源并在一张表里：笔记的（工作区 .nota/trash）和便签的（便签目录下）。
 *
 * 便签跟笔记库是解耦的 —— 没建库也能记便签，所以它们的删除跟 root 无关。
 * 之前这一屏在没库时整片空着，便签删了以后就再也捞不回来了。
 */
async function load() {
  loading.value = true
  try {
    const notes: TrashItem[] = root.value
      ? await window.api.trashList(root.value).catch(() => [])
      : []
    const st = await window.api.stickyTrashList().catch(() => [])
    items.value = [
      ...st.map((e) => ({
        key: e.key,
        rel: '便签',
        name: e.name,
        deletedAt: e.deletedAt,
        size: e.size,
        isSticky: true,
      })),
      ...notes,
    ].sort((a, b) => b.deletedAt - a.deletedAt)
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => [root.value, store.state.columnView] as const,
  ([, view]) => {
    if (view === 'trash') void load()
  },
  { immediate: true },
)

function onLibraryChanged() {
  if (store.state.columnView === 'trash') void load()
}

onMounted(() => window.addEventListener('nota:library-changed', onLibraryChanged))
onBeforeUnmount(() => window.removeEventListener('nota:library-changed', onLibraryChanged))

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

/** 条数变了，侧栏的小数字也要跟着走 */
function announce() {
  window.dispatchEvent(new CustomEvent('nota:library-changed'))
}

async function restoreOne(t: TrashItem) {
  if (t.isSticky) {
    await window.api.stickyTrashRestore(t.key)
    touchStickies()
  } else {
    await window.api.trashRestore(root.value, t.key)
    await store.refreshTree()
  }
}

async function restore(t: TrashItem) {
  await restoreOne(t)
  items.value = items.value.filter((x) => x.key !== t.key)
  sel.value = sel.value.filter((k) => k !== t.key)
  toast(t.isSticky ? '便签已恢复到列表（收在抽屉里）' : `已恢复到 ${t.rel}`)
  announce()
}

/* ── 多选 ──
   一次删掉一整个文件夹会带进来十几条，一条一条捞回去太折磨人，
   所以要有多选。但勾选框不能常驻：回收站平时就是「看一眼有没有误删」，
   每行前面挂一个空方块，整张列表看着像待办清单。
   所以做成**模式**：默认关着，从顶栏的「多选」或右键菜单进去，
   退出时顺手把选择清掉，不留看不见的勾。 */
const sel = ref<string[]>([])
const selectMode = ref(false)

function startSelect(key?: string) {
  selectMode.value = true
  sel.value = key ? [key] : []
}

function endSelect() {
  selectMode.value = false
  sel.value = []
}

/** 多选模式下点整行就是勾选 */
function onRowClick(t: TrashItem) {
  if (selectMode.value) toggleSel(t.key)
}

watch(selectMode, (on) => {
  if (!on) sel.value = []
})

function isSel(key: string) {
  return sel.value.includes(key)
}

function toggleSel(key: string) {
  sel.value = isSel(key) ? sel.value.filter((k) => k !== key) : [...sel.value, key]
}

function selectAll() {
  sel.value = items.value.map((t) => t.key)
}

function clearSel() {
  sel.value = []
}

const selectedItems = computed(() => items.value.filter((t) => isSel(t.key)))

async function restoreMany(list: TrashItem[]) {
  if (list.length === 0) return
  for (const t of list) await restoreOne(t)
  const gone = new Set(list.map((t) => t.key))
  items.value = items.value.filter((x) => !gone.has(x.key))
  sel.value = sel.value.filter((k) => !gone.has(k))
  toast(`已恢复 ${list.length} 项`)
  announce()
}

const menu = ref<{ x: number; y: number; key: string } | null>(null)

const menuItems = computed<LibMenuItem[]>(() => {
  const n = sel.value.length
  const suffix = n > 1 ? `这 ${n} 项` : '这一项'
  const list: LibMenuItem[] = [
    { id: 'restore', label: `恢复${suffix}`, icon: RotateCcw },
    { id: 'purge', label: `彻底删除${suffix}`, icon: Trash2, danger: true },
  ]
  if (!selectMode.value) {
    list.push({ id: 'multi', label: '多选…', icon: ListChecks, sepBefore: true })
  } else {
    list.push(
      { id: 'all', label: '全选', icon: ListChecks, sepBefore: true },
      { id: 'none', label: '取消选择', icon: Square },
      { id: 'done', label: '完成多选', icon: Check },
    )
  }
  return list
})

function onRowMenu(e: MouseEvent, t: TrashItem) {
  e.preventDefault()
  if (!isSel(t.key)) sel.value = [t.key]
  menu.value = { x: e.clientX, y: e.clientY, key: t.key }
}

function onMenuPick(id: string) {
  const at = menu.value?.key
  menu.value = null
  const list = sel.value.length > 0 ? selectedItems.value : items.value.filter((t) => t.key === at)
  if (id === 'restore') void restoreMany(list)
  else if (id === 'purge') {
    if (list.length) pending.value = { kind: 'many', list }
  } else if (id === 'multi') startSelect(at)
  else if (id === 'all') selectAll()
  else if (id === 'none') clearSel()
  else if (id === 'done') endSelect()
}

/**
 * 彻底删除 / 清空都要过一道确认。
 *
 * 回收站里按下去就是**不可撤销**的（没有第二层兜底），
 * 所以不能像别处那样「点了就删」——先问一句，用户点头才动手。
 * 两件事共用同一个弹窗，靠 pending 记住这次要删的是「一条」还是「全部」。
 */
type Pending =
  | { kind: 'one'; item: TrashItem }
  | { kind: 'many'; list: TrashItem[] }
  | { kind: 'all' }

const pending = ref<Pending | null>(null)

function askPurge(t: TrashItem) {
  pending.value = { kind: 'one', item: t }
}

function askEmpty() {
  if (items.value.length === 0) return
  pending.value = { kind: 'all' }
}

const confirmTitle = computed(() => {
  const p = pending.value
  if (!p) return ''
  if (p.kind === 'all') return '清空回收站？'
  if (p.kind === 'many') return '彻底删除这几项？'
  return p.item.isSticky ? '彻底删除这张便签？' : '彻底删除这篇笔记？'
})
const confirmMessage = computed(() => {
  const p = pending.value
  if (!p) return ''
  if (p.kind === 'all') return `${items.value.length} 项被删的内容会被永久删除，无法恢复。`
  if (p.kind === 'many') {
    const n = p.list.length
    return `${n} 项会被永久删除，无法恢复${p.list.some((t) => t.isDir) ? '（含文件夹里的笔记）' : ''}。`
  }
  return `「${p.item.name}」会被永久删除，无法恢复${
    p.item.isSticky ? '（这张纸和它贴过的图都会一起清掉）' : ''
  }。`
})

async function doConfirm() {
  const p = pending.value
  pending.value = null
  if (!p) return
  if (p.kind === 'one') await purge(p.item)
  else if (p.kind === 'many') await purgeMany(p.list)
  else await emptyAll()
}

async function purgeOne(t: TrashItem) {
  if (t.isSticky) await window.api.stickyTrashPurge(t.key)
  else await window.api.trashPurge(root.value, t.key)
}

async function purge(t: TrashItem) {
  await purgeOne(t)
  items.value = items.value.filter((x) => x.key !== t.key)
  sel.value = sel.value.filter((k) => k !== t.key)
  toast(`已彻底删除 ${t.name}`)
  announce()
}

async function purgeMany(list: TrashItem[]) {
  for (const t of list) await purgeOne(t)
  const gone = new Set(list.map((t) => t.key))
  items.value = items.value.filter((x) => !gone.has(x.key))
  sel.value = sel.value.filter((k) => !gone.has(k))
  toast(`已彻底删除 ${list.length} 项`)
  announce()
}

async function emptyAll() {
  if (items.value.length === 0) return
  // 两边的垃圾桶各清各的：便签那份在便签目录下面，跟工作区无关
  if (root.value) await window.api.trashEmpty(root.value)
  await window.api.stickyTrashEmpty()
  items.value = []
  toast('回收站已清空')
  announce()
}

function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function timeText(ms: number) {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <div class="tv">
    <header class="pn-head">
      <span class="pn-ico tv-ico"><Trash2 :size="14" :stroke-width="1.9" /></span>
      <span class="pn-title">回收站</span>
      <span class="pn-sub">
        {{
          sel.length ? `已选 ${sel.length} / ${items.length}` : `${items.length} 项被删的内容`
        }}
      </span>
      <button
        v-if="items.length > 0 && !selectMode"
        class="pn-x"
        data-tip="多选"
        title="多选"
        @click="startSelect()"
      >
        <ListChecks :size="13" :stroke-width="1.9" />
      </button>
    </header>

    <div class="pn-body">
      <div v-if="loading" class="pn-empty">读取中…</div>
      <div v-else-if="items.length === 0" class="pn-empty">
        回收站是空的。删掉的笔记和便签会先来这里，随时能捞回去。
      </div>
      <template v-else>
        <!-- 多选工具条：批量动作从这里发起。
             原来它们钉在窗口最底下，眼睛扫到底才能找到，
             而且那一条灰带子比列表本身还显眼。 -->
        <div v-if="selectMode" class="tv-bar">
          <button
            class="pn-link"
            data-act="all"
            @click="sel.length === items.length ? clearSel() : selectAll()"
          >
            {{ sel.length === items.length ? '取消全选' : '全选' }}
          </button>
          <span class="tv-bar-sp" />
          <button
            class="pn-btn"
            data-act="restore"
            title="把所选恢复到原位置"
            :disabled="sel.length === 0"
            @click="restoreMany(selectedItems)"
          >
            恢复
          </button>
          <button
            class="pn-btn danger"
            data-act="purge"
            title="彻底删除所选（不可恢复）"
            :disabled="sel.length === 0"
            @click="pending = { kind: 'many', list: selectedItems }"
          >
            删除
          </button>
          <button class="pn-btn" data-act="done" title="退出多选" @click="endSelect">完成</button>
        </div>
        <div class="pn-list">
          <div
            v-for="t in items"
            :key="t.key"
            class="pn-row tv-row"
            :class="{ on: isSel(t.key), picking: selectMode }"
            @click="onRowClick(t)"
            @contextmenu.prevent="onRowMenu($event, t)"
          >
            <!-- 勾选框只在多选模式里长出来 -->
            <button
              v-if="selectMode"
              class="tv-check"
              :class="{ on: isSel(t.key) }"
              :title="isSel(t.key) ? '取消选择' : '选择'"
              @click.stop="toggleSel(t.key)"
            >
              <Check v-if="isSel(t.key)" :size="11" :stroke-width="3" />
            </button>
            <Folder v-if="t.isDir" class="pn-row-ico" :size="14" :stroke-width="1.8" />
            <StickyNote
              v-else-if="t.isSticky"
              class="pn-row-ico tv-sticky"
              :size="14"
              :stroke-width="1.8"
            />
            <FileText v-else class="pn-row-ico" :size="14" :stroke-width="1.8" />
            <span class="pn-row-main">
              <span class="pn-row-name">
                {{ t.name }}
                <span v-if="t.isDir" class="tv-dir">文件夹</span>
              </span>
              <span class="pn-row-sub">{{ timeText(t.deletedAt) }} · {{ sizeText(t.size) }}</span>
              <span class="pn-row-sub">{{ t.rel }}</span>
            </span>
            <template v-if="!selectMode">
              <button class="pn-act tv-restore" title="恢复到原位置" @click="restore(t)">
                <RotateCcw :size="12" :stroke-width="2" />
              </button>
              <button class="pn-act danger" title="彻底删除" @click="askPurge(t)">
                <Trash2 :size="12" :stroke-width="2" />
              </button>
            </template>
          </div>
        </div>
        <div class="pn-foot">
          <span class="pn-tip">
            <HistoryIcon :size="11" :stroke-width="1.9" />
            清空之后才真的没了
          </span>
          <button class="pn-btn danger" @click="askEmpty">清空回收站</button>
        </div>
      </template>
    </div>

    <LibContextMenu
      :open="!!menu"
      :x="menu?.x ?? 0"
      :y="menu?.y ?? 0"
      label="回收站操作"
      :items="menuItems"
      @close="menu = null"
      @pick="onMenuPick"
    />

    <ConfirmDialog
      :open="!!pending"
      :title="confirmTitle"
      :message="confirmMessage"
      confirm-text="永久删除"
      danger
      @confirm="doConfirm"
      @cancel="pending = null"
    />
  </div>
</template>

<style scoped>
.tv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* 回收站是「删除」相关的东西，用警示色而不是强调色，和附件库区分开 */
.tv-ico {
  color: var(--n-danger);
}

/* 恢复用图标就够了：这一列不宽，两个字反而挤 */
.tv-restore {
  width: 28px;
  padding: 0;
}

.tv-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
    /* 同 .av-bar：资料栏能窄到 240px，宁可整齐折行也不要被捏扁 */
  flex-wrap: wrap;
  row-gap: 6px;
  margin-bottom: 6px;
}

/* 左边「挑哪些」、右边「对这些做什么」 */
.tv-bar-sp {
  flex: 1;
  min-width: 0;
}

.tv-bar .pn-btn {
  height: 24px;
  font-size: 11.5px;
}

.tv-bar .pn-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 多选模式下整行可点，给个手型 */
.tv-row.picking {
  cursor: pointer;
}

.tv-row {
  gap: 6px;
}

.tv-row.on {
  box-shadow: inset 0 0 0 1px var(--n-accent);
}

/* 勾选方块：状态就写在方块里，不用另起一列文字。
   padding 显式写 0：这个方块只有 17px，浏览器默认的 1px 6px 内边距会把
   里面那枚 11px 的勾压成 3px 宽的一条线（"勾没显示全"就是这个原因）。 */
.tv-check {
  flex: none;
  padding: 0;
  width: 17px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  border: 1.5px solid var(--n-line-strong);
  color: #fff;
  transition: background var(--n-dur) var(--n-ease), border-color var(--n-dur) var(--n-ease);
}

.tv-check.on {
  background: var(--n-accent);
  border-color: var(--n-accent);
}

.tv-check svg {
  fill: none;
  stroke: currentColor;
}

.tv-dir {
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid var(--n-line);
  font-size: 9.5px;
  color: var(--n-fg-faint);
}

</style>
