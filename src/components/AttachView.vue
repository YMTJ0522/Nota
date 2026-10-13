<script setup lang="ts">
/**
 * 中间那一列的「附件库」视图。
 *
 * 工作区 `attachments/` 下的图片与视频，挑一个插进正在写的笔记。
 *
 * 它原来是一个独立弹窗，现在住进了中间那一列 —— 用户的话是「别单独做一个窗口了，
 * 就在那个栏上显示」。这样插图的动作可以眼不离正文：左边挑素材、右边就是
 * 光标等着插进去的地方，不用先关掉一层遮罩再找光标。
 *
 * 插入不走 props 层层传，而是抛一个 nota:insert 事件——
 * 附件库可能从侧栏被唤起，让它直接认识编辑器会把两边焊死。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Check,
  Copy,
  FileDown,
  Image as ImageIcon,
  ListChecks,
  Paperclip,
  RefreshCw,
  Square,
  Trash2,
  Upload,
  Video,
} from 'lucide-vue-next'
import { store } from '@/store'
import { escapeLinkDestination } from '@/editor/markdown-commands'
import LibContextMenu, { type LibMenuItem } from '@/components/LibContextMenu.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface Attach {
  rel: string
  name: string
  size: number
  mtime: number
  isVideo: boolean
  url?: string
}

const items = ref<Attach[]>([])
const loading = ref(false)

const root = computed(() => store.state.root ?? '')

async function load() {
  if (!root.value) {
    items.value = []
    return
  }
  loading.value = true
  try {
    const list = await window.api.attachList(root.value)
    // 缩略图要逐个换算成可加载的 URL，和预览区走同一条路
    items.value = await Promise.all(
      list.map(async (a) => ({
        ...a,
        url: (await window.api.resolveMedia(root.value, a.rel)) ?? '',
      })),
    )
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

// 换工作区时重取；这一列在别的视图待着时不做无用功
watch(
  () => [root.value, store.state.columnView] as const,
  ([r, view]) => {
    if (r && view === 'attach') void load()
    else if (!r) items.value = []
  },
  { immediate: true },
)

/** 别处动了附件（上传完新图、回收站清空），侧栏会抛这个事件让计数跟着变 */
function onLibraryChanged() {
  if (store.state.columnView === 'attach') void load()
}

onMounted(() => window.addEventListener('nota:library-changed', onLibraryChanged))
onBeforeUnmount(() => window.removeEventListener('nota:library-changed', onLibraryChanged))

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

function snippetOf(a: Attach) {
  return a.isVideo
    ? `<video src="${a.rel}" controls></video>`
    : `![${a.name.replace(/\.[^.]+$/, '')}](${escapeLinkDestination(a.rel)})`
}

function insert(a: Attach) {
  window.dispatchEvent(new CustomEvent('nota:insert', { detail: snippetOf(a) }))
  toast('已插入到当前笔记')
}

/** 一次插多个：按顺序拼成一段，块级素材各占一行 */
function insertMany(list: Attach[]) {
  if (list.length === 0) return
  const text = list.map((a) => snippetOf(a)).join('\n\n')
  window.dispatchEvent(new CustomEvent('nota:insert', { detail: text }))
  toast(`已插入 ${list.length} 个附件`)
}

async function remove(a: Attach) {
  if (!root.value) return
  await window.api.attachDelete(root.value, a.rel)
  items.value = items.value.filter((x) => x.rel !== a.rel)
  sel.value = sel.value.filter((r) => r !== a.rel)
  toast(`已删除 ${a.name}`)
  // 附件数变了，侧栏那个小数字要跟着走
  window.dispatchEvent(new CustomEvent('nota:library-changed'))
}

/* ── 多选 ──
   一个库里几十个素材、要删掉其中七八个时，一个一个点删除是折磨。
   但反过来，常驻的勾选框同样折磨：不挑东西的时候，每张卡片角上挂着一个
   小方块，卡片就再也不像卡片了（用户的原话是「直接出现多选框会很丑」）。
   所以多选是一个**模式**：默认关着，勾选框、全选、批量按钮都不出现；
   从顶栏的「多选」或者卡片右键菜单里进去，才切换成挑东西的状态，
   挑完点「完成」退出来。 */
const sel = ref<string[]>([])
const selectMode = ref(false)

function startSelect(rel?: string) {
  selectMode.value = true
  sel.value = rel ? [rel] : []
}

function endSelect() {
  selectMode.value = false
  sel.value = []
}

function isSel(rel: string) {
  return sel.value.includes(rel)
}

function toggleSel(rel: string) {
  sel.value = isSel(rel) ? sel.value.filter((r) => r !== rel) : [...sel.value, rel]
}

function selectAll() {
  sel.value = items.value.map((a) => a.rel)
}

function clearSel() {
  sel.value = []
}

const selectedItems = computed(() => items.value.filter((a) => isSel(a.rel)))

/** 右键菜单：勾了东西就对这批下手，没勾就只对右键点中的这一个 */
const menu = ref<{ x: number; y: number; rel: string } | null>(null)

const menuItems = computed<LibMenuItem[]>(() => {
  const n = sel.value.length
  const suffix = n > 1 ? `这 ${n} 个` : '这个'
  const items: LibMenuItem[] = [
    { id: 'insert', label: `插入${suffix}`, icon: FileDown },
    { id: 'copy', label: '复制引用路径', icon: Copy, sepBefore: true },
    { id: 'remove', label: `删除${suffix}`, icon: Trash2, danger: true },
  ]
  // 多选是一个模式，所以菜单里得有个进出的门
  if (!selectMode.value) {
    items.push({ id: 'multi', label: '多选…', icon: ListChecks, sepBefore: true })
  } else {
    items.push(
      { id: 'all', label: '全选', icon: ListChecks, sepBefore: true },
      { id: 'none', label: '取消选择', icon: Square },
      { id: 'done', label: '完成多选', icon: Check },
    )
  }
  items.push({ id: 'import', label: '导入附件…', icon: Upload, sepBefore: true })
  return items
})

function onCardMenu(e: MouseEvent, a: Attach) {
  e.preventDefault()
  // 右键一个没勾上的：把选择收敛到它身上，后续动作就不用再猜指的是谁
  if (!isSel(a.rel)) sel.value = [a.rel]
  menu.value = { x: e.clientX, y: e.clientY, rel: a.rel }
}

/** 多选模式下点卡片本体就是勾选，不用非去戳那个小方块 */
function onCardClick(a: Attach) {
  if (selectMode.value) toggleSel(a.rel)
}

/** 退到普通模式：清掉选择，免得留着一堆勾看不见 */
watch(selectMode, (on) => {
  if (!on) sel.value = []
})

async function onMenuPick(id: string) {
  const at = menu.value?.rel
  menu.value = null
  const list = sel.value.length > 0 ? selectedItems.value : items.value.filter((a) => a.rel === at)

  if (id === 'insert') {
    insertMany(list)
  } else if (id === 'copy') {
    const text = list.map((a) => a.rel).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast('路径已复制')
    } catch {
      toast('剪贴板不可用')
    }
  } else if (id === 'remove') {
    if (list.length === 0) return
    pending.value = { list }
  } else if (id === 'multi') {
    startSelect(at)
  } else if (id === 'all') {
    selectAll()
  } else if (id === 'none') {
    clearSel()
  } else if (id === 'done') {
    endSelect()
  } else if (id === 'import') {
    await importFiles()
  }
}

/* ── 导入 ──
   附件库是工作区的素材抽屉，不是图片夹：压缩包、PDF、音频都收得进来，
   挑的时候再决定要不要插进笔记。 */
async function importFiles() {
  if (!root.value) return
  const added = (await window.api.attachImport?.(root.value)) ?? []
  if (added.length === 0) return
  await load()
  window.dispatchEvent(new CustomEvent('nota:library-changed'))
  toast(added.length === 1 ? `已导入 ${added[0].name}` : `已导入 ${added.length} 个附件`)
}

/** 批量删除要过一道确认：这里的删除是直接从磁盘抹掉，没有回收站 */
const pending = ref<{ list: Attach[] } | null>(null)

async function doRemoveBatch() {
  const list = pending.value?.list ?? []
  pending.value = null
  if (list.length === 0 || !root.value) return
  for (const a of list) {
    await window.api.attachDelete(root.value, a.rel)
  }
  const gone = new Set(list.map((a) => a.rel))
  items.value = items.value.filter((x) => !gone.has(x.rel))
  sel.value = sel.value.filter((r) => !gone.has(r))
  toast(`已删除 ${list.length} 个附件`)
  window.dispatchEvent(new CustomEvent('nota:library-changed'))
}

function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

defineExpose({ count: computed(() => items.value.length), reload: load })
</script>

<template>
  <div class="av">
    <header class="pn-head">
      <span class="pn-ico"><Paperclip :size="14" :stroke-width="1.9" /></span>
      <span class="pn-title">附件库</span>
      <span class="pn-sub">
        {{ root ? (sel.length ? `已选 ${sel.length} / ${items.length}` : `${items.length} 个文件`) : '' }}
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
      <button class="pn-x" data-tip="导入附件" title="导入附件" @click="importFiles">
        <Upload :size="13" :stroke-width="1.9" />
      </button>
      <button class="pn-x" data-tip="重新读取" title="重新读取" @click="load()">
        <RefreshCw :size="13" :stroke-width="1.9" />
      </button>
    </header>

    <div class="pn-body">
      <div v-if="!root" class="pn-empty">先打开一个笔记目录</div>
      <div v-else-if="loading" class="pn-empty">读取中…</div>
      <div v-else-if="items.length === 0" class="pn-empty">
        还没有附件。点上面的「导入」把文件收进来，或者用工具栏的「插入图片或视频」添加。
        文件都存在工作区的 <code>attachments/</code> 目录里。
      </div>
      <template v-else>
        <!-- 多选模式的那条工具条。批量动作都在这上面 ——
             原来它们吊在窗口底边，离鼠标和卡片都很远，一屏看下来
             最显眼的反而是那条压在最下面的灰带子。 -->
        <div v-if="selectMode" class="av-bar">
          <button
            class="pn-link"
            data-act="all"
            @click="sel.length === items.length ? clearSel() : selectAll()"
          >
            {{ sel.length === items.length ? '取消全选' : '全选' }}
          </button>
          <span class="av-bar-sp" />
          <button
            class="pn-btn"
            data-act="insert"
            title="把所选插入到当前笔记"
            :disabled="sel.length === 0"
            @click="insertMany(selectedItems)"
          >
            插入
          </button>
          <button
            class="pn-btn danger"
            data-act="delete"
            title="从附件库删除所选"
            :disabled="sel.length === 0"
            @click="pending = { list: selectedItems }"
          >
            删除
          </button>
          <button class="pn-btn" data-act="done" title="退出多选" @click="endSelect">完成</button>
        </div>
        <div class="av-grid" :class="{ picking: selectMode }">
          <div
            v-for="a in items"
            :key="a.rel"
            class="av-card"
            :class="{ on: isSel(a.rel) }"
            @click="onCardClick(a)"
            @contextmenu.prevent="onCardMenu($event, a)"
          >
            <div class="av-thumb">
              <img v-if="!a.isVideo && a.url" :src="a.url" :alt="a.name" loading="lazy" />
              <video v-else-if="a.isVideo && a.url" :src="a.url" muted preload="metadata" />
              <ImageIcon v-else :size="18" :stroke-width="1.7" />
              <span v-if="a.isVideo" class="av-badge">
                <Video :size="10" :stroke-width="2" />
              </span>
              <!-- 勾选框只在多选模式里长出来 -->
              <button
                v-if="selectMode"
                class="av-check"
                :class="{ on: isSel(a.rel) }"
                :title="isSel(a.rel) ? '取消选择' : '选择'"
                @click.stop="toggleSel(a.rel)"
              >
                <Check v-if="isSel(a.rel)" :size="11" :stroke-width="3" />
              </button>
            </div>
            <div class="av-name" :title="a.name">{{ a.name }}</div>
            <div class="av-sub">{{ sizeText(a.size) }}</div>
            <!-- 挑东西的时候把单张的按钮收起来：这会儿点它们只会误操作 -->
            <div v-if="!selectMode" class="av-acts">
              <button class="pn-act av-insert" title="插入到当前笔记" @click.stop="insert(a)">
                插入
              </button>
              <button class="pn-act danger av-del" title="删除文件" @click.stop="remove(a)">
                <Trash2 :size="12" :stroke-width="2" />
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <LibContextMenu
      :open="!!menu"
      :x="menu?.x ?? 0"
      :y="menu?.y ?? 0"
      label="附件操作"
      :items="menuItems"
      @close="menu = null"
      @pick="onMenuPick"
    />

    <ConfirmDialog
      :open="!!pending"
      title="删除附件？"
      :message="`${pending?.list.length ?? 0} 个文件会被直接从磁盘删除，这里没有回收站。`"
      confirm-text="删除"
      danger
      @confirm="doRemoveBatch"
      @cancel="pending = null"
    />
  </div>
</template>

<style scoped>
.av {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* 一格放不下就自己换行：栏宽可以拖，网格得跟得上 */
.av-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 10px;
}

/**
 * 多选工具条。
 *
 * 「已选 N 个」不再在这儿写一遍 —— 顶栏的 `.pn-sub` 已经显示 `已选 N / M`，
 * 同一件事写两处既占地方，又把这条窄栏挤爆（资料栏自适应宽度可以窄到 240px）。
 * 批量按钮同理：字收成两个，完整说法放进 title。
 *
 * flex-wrap 是保险丝：真被压到放不下时，宁可整齐地折成两行，
 * 也不要让 flex 把按钮捏扁、文字在里面换行（2.2.2 之前就是这个样子）。
 */
.av-bar {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  row-gap: 6px;
  margin-bottom: 8px;
}

/* 把批量按钮推到右边：左边是「挑哪些」，右边是「对这些做什么」 */
.av-bar-sp {
  flex: 1;
  min-width: 0;
}

/* 工具条上的批量按钮：小一号，贴着顶栏不抢戏 */
.av-bar .pn-btn {
  height: 24px;
  font-size: 11.5px;
}

.av-bar .pn-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 多选模式下整张卡片可点：给个手型，说明「点一下就是勾上」 */
.av-grid.picking .av-card {
  cursor: pointer;
}

.av-card {
  position: relative;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  overflow: hidden;
  transition: border-color var(--n-dur) var(--n-ease), box-shadow var(--n-dur) var(--n-ease);
}

/* 选中态：一圈强调色描边，比整块染色轻，一堆卡片里也不会糊成一片 */
.av-card.on {
  border-color: var(--n-accent);
  box-shadow: 0 0 0 1px var(--n-accent);
}

/* 勾选方块只在多选模式里渲染（模板上有 v-if），所以这里不用再藏 */
.av-check {
  padding: 0;
  position: absolute;
  top: 5px;
  left: 5px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.32);
  color: #fff;
  transition: background var(--n-dur) var(--n-ease), border-color var(--n-dur) var(--n-ease);
}

.av-check.on {
  background: var(--n-accent);
  border-color: var(--n-accent);
}

.av-check svg {
  fill: none;
  stroke: currentColor;
}

.av-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 84px;
  background: var(--n-sunken);
  color: var(--n-fg-faint);
  overflow: hidden;
}

.av-thumb svg {
  fill: none;
  stroke: currentColor;
}

.av-thumb img,
.av-thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.av-badge {
  position: absolute;
  left: 6px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  padding: 2px 5px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}

.av-badge svg {
  fill: none;
  stroke: currentColor;
}

.av-name {
  padding: 6px 8px 2px;
  font-size: 11.5px;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.av-sub {
  padding: 0 8px 6px;
  font-size: 10px;
  color: var(--n-fg-faint);
}

.av-acts {
  display: flex;
  gap: 4px;
  padding: 0 6px 6px;
}

.av-insert {
  flex: 1;
}

.av-del {
  width: 28px;
  padding: 0;
}
</style>
