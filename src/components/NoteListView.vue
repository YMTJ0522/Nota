<script setup lang="ts">
/**
 * 中间那一列的「笔记」视图。
 *
 * 侧栏回答「去哪找」，这一栏回答「有哪些」：
 * 把当前视图（所有笔记 / 最近编辑 / 收藏 / 未归类 / 某个标签 / 搜索结果）
 * 下的笔记拍平成一列，标题 + 摘要 + 所属目录 + 标签 + 修改时间一次看全，
 * 不用像目录树那样一层层展开。
 *
 * 顶上那条搜索框原来在侧栏：两个输入框写同一件事，用哪个都显得另一个多余。
 * 现在只有这一条 —— 「筛选出哪些笔记」本来就属于这一栏。
 *
 * 摘要由主进程在扫目录时顺手从文件头部摘出来（见 workspace:tree），
 * 不额外读盘，所以开着这一栏也不会让打开工作区变慢。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Search, Star, Trash2, X } from 'lucide-vue-next'
import { store } from '@/store'
import type { TreeNode } from '@/store'
import NoteContextMenu, { type NoteExportKind } from '@/components/NoteContextMenu.vue'
import PromptDialog from '@/components/PromptDialog.vue'
import FolderPicker from '@/components/FolderPicker.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const { state } = store

const files = computed(() => store.visibleFiles.value)
const title = computed(() => store.navTitle.value)
const root = computed(() => state.root ?? '')
const box = ref<HTMLInputElement | null>(null)

/** 去工作区前缀，只留「目录 / 子目录」 */
function folderOf(p: string) {
  return store.folderOfPath(p)
}

/** 今天只给时间，七天内给星期，再往上给日期——越近的信息越细 */
function when(ms?: number) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}`
  const days = Math.floor((now.getTime() - ms) / 86400_000)
  if (days < 7) return `${days === 1 ? '昨天' : `${days} 天前`}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function open(path: string) {
  void store.openNote(path)
}

/* ── 删除：两步走 ──
   点一次垃圾桶只是「把枪上膛」，那一行会变成红色的「确认删除」，
   再点一次才真的删。笔记进的是应用内回收站，但误删一次仍然要花
   一分钟去恢复，所以这里宁可多一次点击。

   上膛状态 4 秒后自动解除：放着不管的红色按钮本身就是个隐患。 */
const confirmPath = ref('')
let disarmTimer: ReturnType<typeof setTimeout> | null = null

function askRemove(path: string) {
  confirmPath.value = path
  if (disarmTimer) clearTimeout(disarmTimer)
  disarmTimer = setTimeout(() => {
    confirmPath.value = ''
  }, 4000)
}

function cancelRemove() {
  confirmPath.value = ''
  if (disarmTimer) clearTimeout(disarmTimer)
}

async function doRemove(path: string, name: string) {
  cancelRemove()
  await store.removeNote(path)
  toast(`《${name}》已移入回收站`)
}

/* ── 右键菜单 ── */
const menu = ref<{ x: number; y: number; path: string; starred: boolean } | null>(null)
/** 菜单里点了「重命名 / 归类 / 删除」时，要先把路径留下来 */
const actionPath = ref('')
const renameOpen = ref(false)
const moveOpen = ref(false)
const removeOpen = ref(false)

const actionName = computed(() => store.baseNameOf(actionPath.value))

function onContextMenu(e: MouseEvent, f: TreeNode) {
  e.preventDefault()
  cancelRemove()
  menu.value = { x: e.clientX, y: e.clientY, path: f.path, starred: !!f.starred }
}

function closeMenu() {
  menu.value = null
}

/**
 * 菜单里那些动作都对准右键点中的那篇。
 * 顺手把路径交给弹窗类动作（重命名 / 归类 / 删除确认）共用，并把菜单收掉。
 */
function takeMenu(): string {
  const p = menu.value?.path ?? ''
  actionPath.value = p
  closeMenu()
  return p
}

function onMenuStar() {
  const p = menu.value?.path
  closeMenu()
  if (!p) return
  void store.toggleStar(p).then((on) => toast(on ? '已收藏' : '已取消收藏'))
}

/** 卡片上那枚星：不用开右键菜单也能收藏 */
function toggleStar(f: TreeNode) {
  void store.toggleStar(f.path).then((on) => toast(on ? `已收藏《${f.name.replace(/\.md$/i, '')}》` : '已取消收藏'))
}

function onMenuOpen() {
  const p = menu.value?.path
  closeMenu()
  if (p) void store.openNote(p)
}

async function copyPath() {
  const p = takeMenu()
  try {
    await navigator.clipboard.writeText(p)
    toast('路径已复制')
  } catch {
    toast('剪贴板不可用')
  }
}

async function reveal() {
  const p = takeMenu()
  await store.revealNote(p)
}

async function doExport(kind: NoteExportKind) {
  const p = takeMenu()
  const name = store.baseNameOf(p)
  const out = await store.exportNoteAs(p, kind)
  if (out) toast(`已导出到 ${out}`)
  else toast(`导出 ${name} 已取消`)
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

async function commitRename(v: string) {
  renameOpen.value = false
  await store.renameNote(actionPath.value, v)
}

async function commitMove(dir: string) {
  moveOpen.value = false
  const from = actionPath.value
  const next = await store.moveNoteTo(from, dir)
  if (next !== from) toast('已归类')
}

async function commitRemove() {
  removeOpen.value = false
  await doRemove(actionPath.value, actionName.value)
}

/** 窄轨那枚放大镜点过来时，把焦点交给这里 */
function focusSearch() {
  box.value?.focus()
  box.value?.select()
}

/** 点别处 / 按 Esc 都算「我不想删了」 */
function onDocDown(e: PointerEvent) {
  if (!confirmPath.value) return
  const el = e.target as HTMLElement
  if (!el.closest?.('.nl-item')) cancelRemove()
}

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && confirmPath.value) cancelRemove()
}

onMounted(() => {
  window.addEventListener('nota:focus-search', focusSearch)
  document.addEventListener('pointerdown', onDocDown, true)
  document.addEventListener('keydown', onEsc, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('nota:focus-search', focusSearch)
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onEsc, true)
  if (disarmTimer) clearTimeout(disarmTimer)
})
</script>

<template>
  <div class="nlist">
    <!-- 顶上先是一条筛选：和侧栏的导航一起决定「这一栏列出哪些」 -->
    <div class="nl-search">
      <Search class="nl-search-ico" :size="13" :stroke-width="2" />
      <input
        ref="box"
        class="nl-search-input"
        type="text"
        placeholder="在笔记中筛选…"
        spellcheck="false"
        :value="state.searchQuery"
        @input="store.setSearchQuery(($event.target as HTMLInputElement).value)"
      />
      <button
        v-if="state.searchQuery"
        class="nl-search-x"
        title="清除"
        @click="store.setSearchQuery('')"
      >
        <X :size="12" :stroke-width="2.2" />
      </button>
    </div>

    <!-- 这条只报「这一列里有什么」：标题和条数。
         新建 / 导入两枚按钮已经挪到编辑区顶栏（见 EditorActions），
         理由写在那边 —— 它们跟「这个列表里有什么」本来就不相干。 -->
    <div class="nl-head">
      <span class="nl-title">{{ title }}</span>
      <span class="nl-count">{{ files.length }}</span>
    </div>

    <div class="nl-scroll">
      <div v-if="state.loading" class="nl-empty">读取中…</div>
      <!-- 空态不再摆两枚大按钮：按钮一出现界面就跳一下，
           而且同一件事在上面的顶栏里一直有个更稳的入口。 -->
      <div v-else-if="files.length === 0" class="nl-empty">
        <template v-if="state.searchQuery || state.activeTag">这里没有匹配的笔记</template>
        <template v-else>这里还没有 .md 文件。</template>
      </div>
      <template v-else>
        <div
          v-for="f in files"
          :key="f.path"
          class="nl-item"
          :class="{ on: f.path === state.activePath, arming: confirmPath === f.path }"
          role="button"
          tabindex="0"
          :title="f.path"
          @click="open(f.path)"
          @keydown.enter.prevent="open(f.path)"
          @contextmenu.prevent="onContextMenu($event, f)"
        >
          <span class="nl-name">
            <span class="nl-text">{{ f.name.replace(/\.md$/i, '') }}</span>
          </span>
          <span v-if="f.excerpt" class="nl-excerpt">{{ f.excerpt }}</span>
          <span class="nl-meta">
            <span class="nl-folder">{{ folderOf(f.path) }}</span>
            <span class="nl-when">{{ when(f.mtime) }}</span>
          </span>
          <!-- 标签单独一行：和文件夹挤在一行时，长目录名会把标签整个挤掉 -->
          <span class="nl-tags">
            <span v-for="t in f.tags ?? []" :key="t" class="nl-tag">#{{ t }}</span>
            <span v-if="!f.tags?.length" class="nl-tag nl-tag-none">未打标签</span>
          </span>

          <!-- 删除 / 收藏：先上膛，再确认。不删就点别处，它自己会退回去 -->
          <span class="nl-card-acts">
            <button
              class="nl-star-btn"
              :class="{ on: f.starred }"
              :title="f.starred ? '取消收藏' : '收藏'"
              @click.stop="toggleStar(f)"
            >
              <Star :size="13" :stroke-width="1.9" />
            </button>
            <template v-if="confirmPath === f.path">
              <button class="nl-del-yes" @click.stop="doRemove(f.path, f.name.replace(/\.md$/i, ''))">
                确认删除
              </button>
              <button class="nl-del-no" title="取消" @click.stop="cancelRemove">
                <X :size="12" :stroke-width="2.2" />
              </button>
            </template>
            <button
              v-else
              class="nl-del"
              title="删除笔记（会先进回收站）"
              @click.stop="askRemove(f.path)"
            >
              <Trash2 :size="13" :stroke-width="1.9" />
            </button>
          </span>
        </div>
      </template>
    </div>

    <NoteContextMenu
      :target="menu"
      @close="closeMenu"
      @open="onMenuOpen"
      @star="onMenuStar"
      @rename="() => { takeMenu(); renameOpen = true }"
      @move="() => { takeMenu(); moveOpen = true }"
      @copy-path="copyPath"
      @reveal="reveal"
      @export="doExport"
      @remove="() => { takeMenu(); removeOpen = true }"
    />

    <PromptDialog
      :open="renameOpen"
      title="重命名"
      label="标题"
      :initial="actionName"
      placeholder="输入新的笔记名"
      confirm-text="重命名"
      @confirm="commitRename"
      @cancel="renameOpen = false"
    />

    <FolderPicker
      :open="moveOpen"
      :note-name="actionName"
      @pick="commitMove"
      @close="moveOpen = false"
    />

    <ConfirmDialog
      :open="removeOpen"
      title="删除这篇笔记？"
      :message="`《${actionName}》会被移入回收站，之后还能恢复。`"
      confirm-text="确认删除"
      danger
      @confirm="commitRemove"
      @cancel="removeOpen = false"
    />
  </div>
</template>

<style scoped>
.nlist {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* ── 筛选行 ──
   长得像输入框但更安静：它是这一栏的日常入口，不该比笔记本身还抢眼 */
.nl-search {
  flex: none;
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin: 8px 8px 2px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--n-line) 54%, transparent);
  background: color-mix(in oklab, var(--n-raised) 42%, var(--n-sunken));
  transition: border-color var(--n-dur) var(--n-ease),
    background-color var(--n-dur) var(--n-ease);
}

.nl-search:hover,
.nl-search:focus-within {
  border-color: color-mix(in oklab, var(--n-line) 88%, transparent);
  background: color-mix(in oklab, var(--n-raised) 72%, var(--n-sunken));
}

.nl-search:focus-within {
  border-color: var(--n-accent);
}

.nl-search-ico {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-fg-faint);
}

.nl-search-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  background: none;
  border: none;
  outline: none;
}

.nl-search-input::placeholder {
  color: color-mix(in oklab, var(--n-fg-faint) 82%, transparent);
}

.nl-search-x {
  padding: 0;
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--n-fg-faint);
}

.nl-search-x svg {
  fill: none;
  stroke: currentColor;
}

.nl-search-x:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.nl-head {
  flex: none;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 14px;
}

.nl-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nl-count {
  flex: none;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
}

.nl-head svg {
  fill: none;
  stroke: currentColor;
}

.nl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.nl-empty {
  padding: 18px 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--n-fg-faint);
}


/* ── 一条笔记 ──
   注意它是 div 而不是 button：卡片里还住着「删除」按钮，
   button 套 button 是非法结构，点击也会被内层吞掉。 */
.nl-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px 34px 8px 10px;
  border-radius: var(--n-r-md);
  text-align: left;
  cursor: pointer;
  transition: background var(--n-dur) var(--n-ease);
}

.nl-item:focus-visible {
  outline: 2px solid var(--n-accent);
  outline-offset: -2px;
}

/* 上膛状态：整张卡片泛一层红，跟普通悬停区分开 */
.nl-item.arming {
  background: color-mix(in oklab, var(--n-danger) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--n-danger) 42%, transparent);
}

/* ── 卡片右上角那几个动作 ──
   曾经它和头部那组按钮都叫 .nl-acts，重名的结果是头部的「新建笔记」
   吃到了这里的 position:absolute，一路飘到窗口右上角、正好压在关闭按钮上
   （看起来就像关闭键上多了个「添加」图标）。名字拆开之后就没这回事了。 */
.nl-card-acts {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.nl-star-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
  opacity: 0;
  transition: opacity var(--n-dur) var(--n-ease), background var(--n-dur) var(--n-ease),
    color var(--n-dur) var(--n-ease);
}

.nl-star-btn.on {
  opacity: 1;
  color: var(--n-accent);
}

.nl-star-btn.on svg {
  fill: currentColor;
}

.nl-item:hover .nl-star-btn,
.nl-item:focus-within .nl-star-btn {
  opacity: 1;
}

.nl-star-btn:hover {
  background: color-mix(in oklab, var(--n-accent) 16%, transparent);
  color: var(--n-accent);
}

.nl-star-btn svg {
  fill: none;
  stroke: currentColor;
}

.nl-del {
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
  opacity: 0;
  transition: opacity var(--n-dur) var(--n-ease), background var(--n-dur) var(--n-ease),
    color var(--n-dur) var(--n-ease);
}

.nl-del svg {
  fill: none;
  stroke: currentColor;
}

/* 平时藏着，指到这张卡片才出现——列表里不该有一排垃圾桶在抢注意力 */
.nl-item:hover .nl-del,
.nl-item:focus-within .nl-del,
.nl-item.on .nl-del {
  opacity: 1;
}

.nl-del:hover {
  background: color-mix(in oklab, var(--n-danger) 18%, transparent);
  color: var(--n-danger);
}

.nl-del-yes {
  height: 24px;
  padding: 0 9px;
  border-radius: var(--n-r-sm);
  background: var(--n-danger);
  color: #fff;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}

.nl-del-yes:hover {
  filter: brightness(1.08);
}

.nl-del-no {
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  color: var(--n-fg-dim);
}

.nl-del-no svg {
  fill: none;
  stroke: currentColor;
}

.nl-del-no:hover {
  color: var(--n-fg);
}

.nl-item + .nl-item {
  margin-top: 1px;
}

.nl-item:hover {
  background: color-mix(in oklab, var(--n-raised) 62%, transparent);
}

.nl-item.on {
  background: color-mix(in oklab, var(--n-accent-soft) 76%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--n-accent) 22%, transparent);
}

.nl-name {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.nl-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nl-item.on .nl-text {
  font-weight: 600;
}

.nl-star {
  flex: none;
  fill: currentColor;
  stroke: currentColor;
  color: var(--n-accent);
}

/* 摘要两行截断：够认出这篇讲什么，又不会把列表撑散 */
.nl-excerpt {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--n-fg-dim);
  word-break: break-word;
}

.nl-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 1px;
  font-size: 10px;
  color: var(--n-fg-faint);
  min-width: 0;
}

.nl-folder {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nl-when {
  flex: none;
  font-variant-numeric: tabular-nums;
}

/* 标签独占一行，超过一行就换行，不再被挤没 */
.nl-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 1px;
  font-size: 10px;
}

.nl-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--n-accent-soft) 90%, transparent);
  color: color-mix(in oklab, var(--n-accent) 82%, var(--n-fg));
  white-space: nowrap;
}

.nl-tag-none {
  background: none;
  color: var(--n-fg-faint);
}
</style>
