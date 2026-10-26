<script setup lang="ts">
/**
 * 中间那一列的「便签」视图。
 *
 * 便签是关在独立小窗口里的，这里是它们的账本：还开着的、已经收进抽屉的、
 * 以及存进笔记库的，都在这一屏。没有这一屏，用户按 Esc 关掉一张纸之后
 * 就再也找不回来了 —— 归档就等于丢失。
 *
 * 点一条就把它重新放到桌面上（不是在这一列里展开编辑）：便签的用法是
 * 「贴在屏幕角落随手写」，在窄栏里改字反而不顺手。
 *
 * 这一屏的顶栏没有按钮 —— 「新建 / 收起全部」在资料栏右上角，
 * 和笔记页的「新建 / 导入」同一个位置（见 SideColumn）。以前那一条
 * 实心彩按钮横在列表上方，这一列别处都没有那种条，看着像外来零件。
 *
 * 管理动作和笔记那一边对齐：右键出菜单（打开 / 重命名 / 标记 / 复制 /
 * 存为笔记 / 定位 / 删除），顶上一条筛选框，标签点一下就筛。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown, FolderOpen, Hash, Search, StickyNote, Trash2, X } from 'lucide-vue-next'
import { store } from '@/store'
import BrandGlyph from '@/components/BrandGlyph.vue'
import PromptDialog from '@/components/PromptDialog.vue'
import StickyContextMenu from '@/components/StickyContextMenu.vue'
import StickyMarkDialog from '@/components/StickyMarkDialog.vue'
import { paperOf } from '@/sticky/colors'

const items = ref<StickyItem[]>([])
const loading = ref(false)
/** 已归档的默认收起来：桌面上真正在用的一般就那么几张，历史不该占满一屏 */
const showArchived = ref(false)
/** 正在等着二次确认的那一条 */
const confirming = ref<string | null>(null)
let confirmTimer = 0

/** 筛选词。便签的正文不长，全在内存里筛，不额外读盘 */
const q = ref('')
/** 点标签筛。null = 不筛 */
const tagFilter = ref<string | null>(null)

const menu = ref<{ x: number; y: number; id: string; saved: boolean } | null>(null)
const actId = ref('')
const renameOpen = ref(false)
const markOpen = ref(false)

const openList = computed(() => items.value.filter((s) => !s.closedAt))
const archivedList = computed(() => items.value.filter((s) => s.closedAt))

/** 所有便签上用过的标签，按用得多的排前面 */
const allTags = computed(() => {
  const n = new Map<string, number>()
  for (const s of items.value) for (const t of s.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1)
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([name, count]) => ({ name, count }))
})

/** 标记弹窗的候选：已经有标签的那些，一点就加，免得同义词越攒越多 */
const knownTags = computed(() => allTags.value)

const actItem = computed(() => items.value.find((s) => s.id === actId.value))

const visible = computed(() => {
  const kw = q.value.trim().toLowerCase()
  let list = showArchived.value ? items.value : openList.value
  if (tagFilter.value) list = list.filter((s) => s.tags?.includes(tagFilter.value!))
  if (kw) {
    list = list.filter(
      (s) =>
        s.title.toLowerCase().includes(kw) ||
        s.preview.toLowerCase().includes(kw) ||
        (s.tags ?? []).some((t) => t.toLowerCase().includes(kw)),
    )
  }
  return list
})

const filtering = computed(() => !!q.value.trim() || !!tagFilter.value)

async function load() {
  loading.value = true
  try {
    items.value = await window.api.stickyList()
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => store.state.columnView,
  (v) => {
    if (v === 'stickies') void load()
  },
  { immediate: true },
)

/**
 * 便签窗口开了 / 关了，主进程推张数过来（App.vue 存进 store），
 * 张数一变就重取一遍列表。
 *
 * 这里不去挂 ipc 监听：那个通道只有一个位置能挂（preload 里是覆盖式注册），
 * 挂在 App 上、大家读同一个值，才不会互相踢掉。
 */
watch(
  () => store.state.stickyOpen,
  () => {
    if (store.state.columnView === 'stickies') void load()
  },
)

onBeforeUnmount(() => {
  if (confirmTimer) window.clearTimeout(confirmTimer)
})

/** 时间只做粗粒度：便签没人关心「3 分钟前」还是「4 分钟前」 */
function when(ts: number): string {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  const dt = new Date(ts)
  if (dt.getFullYear() === new Date().getFullYear())
    return `${dt.getMonth() + 1}月${dt.getDate()}日`
  return `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

async function open(s: StickyItem) {
  const ok = await window.api.stickyOpen(s.id)
  if (!ok) toast('开不出来了，先关掉几张别的便签')
  else void load()
}

/**
 * 删除是两段式的：点一下变红、再点才真删。
 * 用确认弹窗太重（在这个窄栏里会盖住整屏），而单点就删又太容易手滑 ——
 * 便签恰恰是那种「不小心按到就没了」最疼的东西。
 */
async function remove(s: StickyItem) {
  if (confirming.value !== s.id) {
    confirming.value = s.id
    if (confirmTimer) window.clearTimeout(confirmTimer)
    confirmTimer = window.setTimeout(() => (confirming.value = null), 3000)
    return
  }
  confirming.value = null
  if (confirmTimer) window.clearTimeout(confirmTimer)
  await window.api.stickyDelete(s.id)
  items.value = items.value.filter((x) => x.id !== s.id)
  toast('便签已删除')
}

async function reveal(id?: string) {
  // 没给 id 就是「打开便签文件夹」；给了就是定位那一个文件
  if (!id) {
    await window.api.revealStickies()
    return
  }
  const ok = await window.api.stickyReveal(id)
  if (!ok) toast('这张便签还没写过字，磁盘上还没有文件')
}

/* ── 右键菜单 ── */
function onMenu(e: MouseEvent, s: StickyItem) {
  e.preventDefault()
  menu.value = { x: e.clientX, y: e.clientY, id: s.id, saved: !!s.savedTo }
}

function closeMenu() {
  menu.value = null
}

/** 菜单里那些动作都对准右键点中的那一张，顺手把菜单收掉 */
function take(): string {
  const id = menu.value?.id ?? ''
  actId.value = id
  closeMenu()
  return id
}

function onMenuOpen() {
  const id = take()
  const s = items.value.find((x) => x.id === id)
  if (s) void open(s)
}

function onMenuRename() {
  if (!take()) return
  renameOpen.value = true
}

function onMenuMark() {
  if (!take()) return
  markOpen.value = true
}

async function onMenuCopy() {
  const id = take()
  if (!id) return
  const text = await window.api.stickyText(id)
  if (!text.trim()) return toast('这张便签还是空的')
  try {
    await navigator.clipboard.writeText(text)
    toast('正文已复制')
  } catch {
    toast('剪贴板不可用')
  }
}

async function onMenuSave() {
  const id = take()
  if (!id) return
  const r = await window.api.stickySaveToVault(id)
  if (!r.ok) return toast(r.error ?? '存不进去')
  toast(`已存入笔记：${r.rel}`)
  void load()
}

function onMenuReveal() {
  const id = take()
  if (id) void reveal(id)
}

async function onMenuRemove() {
  const id = take()
  const s = items.value.find((x) => x.id === id)
  if (s) await remove(s)
}

/* ── 重命名 / 标记 ── */
async function commitRename(v: string) {
  renameOpen.value = false
  const id = actId.value
  if (!id || !v.trim()) return
  const r = await window.api.stickyRename(id, v)
  if (!r.ok) return toast(r.error ?? '改不了名字')
  void load()
}

/** 图标改动即时生效：关掉弹窗不该把点过的选择弄丢 */
async function pickIcon(ic: { kind: 'brand' | 'emoji'; id: string } | null) {
  const id = actId.value
  if (!id) return
  await window.api.stickyPatch(id, { icon: ic })
  const s = items.value.find((x) => x.id === id)
  if (s) {
    if (ic) s.icon = { ...ic }
    else delete s.icon
  }
}

async function setTags(tags: string[]) {
  const id = actId.value
  if (!id) return
  await window.api.stickyPatch(id, { tags })
  const s = items.value.find((x) => x.id === id)
  if (s) s.tags = [...tags]
  // 正在按某个标签筛，而它刚被从最后一张便签上去掉 —— 筛出来的空列表会让人以为丢了东西
  if (tagFilter.value && !items.value.some((x) => x.tags?.includes(tagFilter.value!)))
    tagFilter.value = null
}

function toggleTag(name: string) {
  tagFilter.value = tagFilter.value === name ? null : name
}

/** 一条纸色小圆点：没打标记的便签靠它认「和桌面上那张是一张纸」 */
function dotStyle(s: StickyItem) {
  const p = paperOf(s.color)
  return { background: p.bg, boxShadow: `inset 0 0 0 1px ${p.dim}` }
}
</script>

<template>
  <section class="sv">
    <!-- 顶上一条筛选，和笔记页同一个位置、同一种长相 -->
    <div class="sv-search">
      <Search class="sv-search-ico" :size="13" :stroke-width="2" />
      <input
        v-model="q"
        class="sv-search-input"
        type="text"
        placeholder="在便签中筛选…"
        spellcheck="false"
        @keydown.esc="q = ''"
      />
      <button v-if="q" class="sv-search-x" title="清除" @click="q = ''">
        <X :size="12" :stroke-width="2.2" />
      </button>
    </div>

    <!-- 标签行只在真的打过标签时出现：一张标签都没有的时候摆一排空的筛选器，
         等于在教人「这里有个你还没用上的功能」 -->
    <div v-if="allTags.length" class="sv-tags">
      <button
        v-for="t in allTags"
        :key="t.name"
        class="sv-tag"
        :class="{ on: tagFilter === t.name }"
        :title="`只看带「${t.name}」的便签`"
        @click="toggleTag(t.name)"
      >
        <Hash :size="10" :stroke-width="2.4" />{{ t.name }}
        <span class="sv-tag-n">{{ t.count }}</span>
      </button>
    </div>

    <div class="sv-list">
      <div
        v-for="s in visible"
        :key="s.id"
        class="sv-item"
        :class="{ archived: !!s.closedAt }"
        role="button"
        tabindex="0"
        :title="s.preview || s.title"
        @click="open(s)"
        @keydown.enter.prevent="open(s)"
        @contextmenu.prevent="onMenu($event, s)"
      >
        <span class="sv-ico">
          <BrandGlyph v-if="s.icon?.kind === 'brand'" :id="s.icon.id" :size="16" />
          <span v-else-if="s.icon?.kind === 'emoji'" class="sv-emoji">{{ s.icon.id }}</span>
          <span v-else class="sv-dot" :style="dotStyle(s)" />
        </span>

        <span class="sv-main">
          <span class="sv-head">
            <span class="sv-title">{{ s.title }}</span>
            <span class="sv-time">{{ when(s.updatedAt || s.createdAt) }}</span>
          </span>
          <span v-if="s.preview" class="sv-prev">{{ s.preview }}</span>
          <span v-if="s.closedAt || s.savedTo" class="sv-meta">
            <span v-if="s.closedAt" class="sv-chip">已收起</span>
            <span v-if="s.savedTo" class="sv-chip ok" :title="`已存入 ${s.savedTo}`">
              <Check :size="10" :stroke-width="2.6" />已存入笔记
            </span>
          </span>
        </span>

        <span
          class="sv-del"
          :class="{ confirm: confirming === s.id }"
          :title="confirming === s.id ? '再点一次就删掉' : '删除'"
          @click.stop="remove(s)"
        >
          <Trash2 :size="12" :stroke-width="2" />
        </span>
      </div>

      <!-- 空态分两种：一张都没有 vs 筛掉了。混着说会让人以为便签丢了 -->
      <div v-if="!loading && visible.length === 0" class="sv-empty">
        <StickyNote :size="22" :stroke-width="1.5" />
        <template v-if="filtering">
          <p>没有匹配的便签</p>
          <button class="sv-clear" @click="q = ''; tagFilter = null">清除筛选</button>
        </template>
        <template v-else-if="showArchived">
          <p>还没有便签</p>
        </template>
        <template v-else-if="archivedList.length">
          <p>桌面上的便签都收起来了</p>
          <p class="sub">点底下的「已收起 {{ archivedList.length }} 张」能看到它们</p>
        </template>
        <template v-else>
          <p>还没有便签</p>
          <p class="sub">
            任何时候按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> 记一张，写完可以一键存成笔记
          </p>
        </template>
      </div>
    </div>

    <!-- 底下一条：左边是归档的抽屉，右边是那个文件夹。
         这两件事都跟「列表里有什么」无关，所以压在最下面，
         不占列表的注意力 -->
    <footer class="sv-foot">
      <!-- 归档抽屉的开关。文案固定写「已收起 N 张」——展开时改成
           「只看开着的」会在开着的为 0 时变成一个「只看 0 张」的废按钮 -->
      <button
        v-if="archivedList.length"
        class="sv-more"
        :class="{ open: showArchived }"
        :title="showArchived ? '折叠已收起' : '展开已收起'"
        @click="showArchived = !showArchived"
      >
        <ChevronDown :size="12" :stroke-width="2.2" />
        <span>已收起 {{ archivedList.length }} 张</span>
      </button>
      <span v-else class="sv-count">
        {{ openList.length ? `${openList.length} 张在桌面上` : '桌面上没有便签' }}
      </span>
      <button class="sv-folder" title="打开便签文件夹" @click="reveal()">
        <FolderOpen :size="13" :stroke-width="1.9" />
      </button>
    </footer>

    <StickyContextMenu
      :target="menu"
      @close="closeMenu"
      @open="onMenuOpen"
      @rename="onMenuRename"
      @mark="onMenuMark"
      @copy="onMenuCopy"
      @save="onMenuSave"
      @reveal="onMenuReveal"
      @remove="onMenuRemove"
    />

    <PromptDialog
      :open="renameOpen"
      title="重命名"
      label="标题"
      :initial="actItem?.title ?? ''"
      placeholder="输入新的标题"
      confirm-text="重命名"
      @confirm="commitRename"
      @cancel="renameOpen = false"
    />

    <StickyMarkDialog
      :open="markOpen"
      :title="actItem?.title ?? ''"
      :icon="actItem?.icon ?? null"
      :tags="actItem?.tags ?? []"
      :known="knownTags"
      @close="markOpen = false"
      @pick-icon="pickIcon"
      @set-tags="setTags"
    />
  </section>
</template>

<style scoped>
.sv {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 和笔记页的筛选框同一套尺寸与配色（见 NoteListView 的 .nl-search）：
   两屏挨着看，一条 28 一条 32 会显得这一屏是拼上去的 */
.sv-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin: 8px 8px 2px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--n-line) 54%, transparent);
  background: color-mix(in oklab, var(--n-raised) 42%, var(--n-sunken));
  transition:
    border-color var(--n-dur) var(--n-ease),
    background-color var(--n-dur) var(--n-ease);
}
.sv-search:hover,
.sv-search:focus-within {
  border-color: color-mix(in oklab, var(--n-line) 88%, transparent);
  background: color-mix(in oklab, var(--n-raised) 72%, var(--n-sunken));
}
.sv-search:focus-within {
  border-color: var(--n-accent);
}

.sv-search-ico {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-fg-faint);
}

.sv-search-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  background: none;
  border: none;
  outline: none;
}
.sv-search-input::placeholder {
  color: color-mix(in oklab, var(--n-fg-faint) 82%, transparent);
}

.sv-search-x {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--n-fg-faint);
}
.sv-search-x:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}
.sv-search-x svg {
  fill: none;
  stroke: currentColor;
}

/* 标签行：横向排，超了就自己滚，不换行 —— 换行会把列表顶下去一大截 */
.sv-tags {
  flex: none;
  display: flex;
  gap: 5px;
  padding: 6px 8px 2px;
  overflow-x: auto;
  scrollbar-width: none;
}
.sv-tags::-webkit-scrollbar {
  display: none;
}

.sv-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--n-line);
  background: var(--n-surface);
  font-size: 11px;
  color: var(--n-fg-dim);
  transition:
    background var(--n-dur) var(--n-ease),
    border-color var(--n-dur) var(--n-ease),
    color var(--n-dur) var(--n-ease);
}
.sv-tag svg {
  fill: none;
  stroke: currentColor;
  opacity: 0.7;
}
.sv-tag:hover {
  color: var(--n-fg);
  border-color: color-mix(in oklab, var(--n-line) 70%, var(--n-fg-faint));
}
.sv-tag.on {
  background: color-mix(in oklab, var(--n-accent) 14%, transparent);
  border-color: color-mix(in oklab, var(--n-accent) 45%, transparent);
  color: var(--n-accent);
}
.sv-tag-n {
  font-size: 10px;
  opacity: 0.6;
}

.sv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 6px 8px;
}

/* 一条便签：左边一枚标记（图标 / 纸色点），右边三行。
   内容用 .sv-main 包起来再 flex:1，是因为列向 flex 里长文本会把整行撑出面板
   （见项目里那条「列向 flex + align-items:flex-start」的坑） */
.sv-item {
  position: relative;
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 30px 8px 8px;
  border-radius: 8px;
  cursor: default;
  transition: background 130ms ease;
}
.sv-item:hover {
  background: var(--n-hover, var(--n-surface));
}
.sv-item:focus-visible {
  outline: 2px solid var(--n-accent);
  outline-offset: -2px;
}
/* 收起的那批压暗一档：它们还在，但不是当下在用的 */
.sv-item.archived {
  opacity: 0.62;
}
.sv-item.archived:hover {
  opacity: 0.9;
}

.sv-ico {
  flex: none;
  width: 18px;
  height: 16px;
  display: grid;
  place-items: center;
  margin-top: 1px;
}

.sv-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
}

.sv-emoji {
  font-size: 14px;
  line-height: 1;
}

.sv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sv-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
}

.sv-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sv-time {
  flex: none;
  font-size: 10.5px;
  color: var(--n-fg-dim);
}

.sv-prev {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--n-fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sv-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  flex-wrap: wrap;
}

.sv-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--n-surface);
  color: var(--n-fg-dim);
  white-space: nowrap;
}
.sv-chip svg {
  fill: none;
  stroke: currentColor;
}
.sv-chip.ok {
  color: var(--n-accent);
  background: color-mix(in oklab, var(--n-accent) 12%, transparent);
}

/* 删除按钮平时藏着，鼠标停上去才出现：列表一屏十几条，每条都挂一个红叉
   会让整列看起来很吵 */
.sv-del {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--n-fg-dim);
  opacity: 0;
  transition:
    opacity 130ms ease,
    background 130ms ease,
    color 130ms ease;
}
.sv-item:hover .sv-del {
  opacity: 1;
}
.sv-del svg {
  fill: none;
  stroke: currentColor;
}
.sv-del:hover {
  background: var(--n-surface);
  color: #c0392b;
}
.sv-del.confirm {
  opacity: 1;
  background: #c0392b;
  color: #fff;
}

.sv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 40px 20px;
  color: var(--n-fg-dim);
  text-align: center;
}
.sv-empty svg {
  fill: none;
  stroke: currentColor;
  opacity: 0.75;
}
.sv-empty p {
  margin: 0;
  font-size: 12.5px;
}
.sv-empty .sub {
  font-size: 11.5px;
  line-height: 1.6;
  opacity: 0.85;
}
.sv-empty kbd {
  display: inline-block;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  font-family: inherit;
  font-size: 10.5px;
}

.sv-clear {
  margin-top: 4px;
  height: 24px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid var(--n-line);
  font-size: 11.5px;
  color: var(--n-fg-dim);
}
.sv-clear:hover {
  color: var(--n-fg);
  background: var(--n-surface);
}

.sv-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 8px 0 12px;
  border-top: 1px solid color-mix(in oklab, var(--n-line) 60%, transparent);
}

.sv-more {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 2px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--n-fg-dim);
  text-align: left;
}
.sv-more span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sv-more svg {
  flex: none;
  fill: none;
  stroke: currentColor;
  transition: transform var(--n-dur) var(--n-ease);
}
.sv-more.open svg {
  transform: rotate(180deg);
}
.sv-more:hover {
  color: var(--n-fg);
}

.sv-count {
  flex: 1;
  font-size: 11.5px;
  color: var(--n-fg-faint);
}

.sv-folder {
  flex: none;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--n-fg-dim);
}
.sv-folder svg {
  fill: none;
  stroke: currentColor;
}
.sv-folder:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}
</style>
