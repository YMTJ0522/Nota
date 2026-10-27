<script setup lang="ts">
/**
 * 便签墙 —— 切到「便签」时主区显示的那一屏。
 *
 * 以前切到便签，左边是便签清单，右边还挂着半小时前那篇笔记：一边在整理
 * 便条，一边是被晾着的正文，两件事没有关系。这一屏本该是「便签专用」的，
 * 却像借住在编辑器里。
 *
 * 现在主区改成一面墙：每张纸按自己的纸色铺成一块，标题、正文前几行、
 * 标签都在上面，一眼扫过去就能认出「docker 那张」「昨天那个报错」。
 * 左边那一列仍然是账本 —— 搜索、筛标签、改名、勾选批量；右边这面墙是
 * 浏览用的，两个视角不重复。
 *
 * 为什么不做「点开就地编辑」：便签的用法是贴在屏幕角落随手写，一个能编辑
 * 的卡片会让主区变成第二个小编辑器，和独立窗口抢活。点一下就是把它放到
 * 桌面上，和列表里点一条是同一个动作。
 */
import { computed, ref } from 'vue'
import { Check, Plus, StickyNote } from 'lucide-vue-next'
import { store, touchStickies } from '@/store'
import { dropFromStickies, stickyStore } from '@/store/stickies'
import BrandGlyph from '@/components/BrandGlyph.vue'
import WindowControls from '@/components/WindowControls.vue'
import PromptDialog from '@/components/PromptDialog.vue'
import StickyContextMenu from '@/components/StickyContextMenu.vue'
import StickyMarkDialog from '@/components/StickyMarkDialog.vue'
import { paperOf } from '@/sticky/colors'
import { relTime } from '@/sticky/format'

/* 和左边那一列读的是**同一份**内存数据（见 store/stickies.ts）。
   以前各捏一份快照、靠 stickyRev 互相喊，加第三个入口就得记得也挂 watch。 */
const items = computed(() => stickyStore.items)
const loading = computed(() => stickyStore.loading)
/** 桌面上（开着）的几张往往就是当下要处理的，历史不该一上来占满整面墙 */
const onlyOpen = ref(false)

const menu = ref<{ x: number; y: number; id: string; saved: boolean } | null>(null)
const actId = ref('')
const renameOpen = ref(false)
const markOpen = ref(false)

const shown = computed(() =>
  onlyOpen.value ? items.value.filter((s) => !s.closedAt) : items.value,
)
const openCount = computed(() => items.value.filter((s) => !s.closedAt).length)
const actItem = computed(() => items.value.find((s) => s.id === actId.value))
const knownTags = computed(() => {
  const n = new Map<string, number>()
  for (const s of items.value) for (const t of s.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1)
  return [...n.entries()].map(([name, count]) => ({ name, count }))
})

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

function toastUndo(text: string, run: () => void) {
  window.dispatchEvent(
    new CustomEvent('nota:toast', { detail: { text, action: { label: '撤销', run } } }),
  )
}

async function create() {
  const r = await window.api.stickyNew()
  if ('error' in r) return toast(r.error)
  touchStickies()
}

async function open(s: StickyItem) {
  const ok = await window.api.stickyOpen(s.id)
  if (!ok) toast('开不出来了，先关掉几张别的便签')
  else touchStickies()
}

/* ── 右键菜单：和左边那一列是同一个组件、同一套动作 ── */
function onMenu(e: MouseEvent, s: StickyItem) {
  e.preventDefault()
  menu.value = { x: e.clientX, y: e.clientY, id: s.id, saved: !!s.savedTo }
}

/* 菜单动作带 id 进来（见 StickyContextMenu 顶上的注释）：
   每个动作自己把菜单收掉，不再有一个共享的 take() 去猜「刚才点的是哪张」。 */
function onMenuOpen(id: string) {
  const s = items.value.find((x) => x.id === id)
  if (s) void open(s)
}

function onMenuRename(id: string) {
  if (!id) return
  actId.value = id
  menu.value = null
  renameOpen.value = true
}

function onMenuMark(id: string) {
  if (!id) return
  actId.value = id
  menu.value = null
  markOpen.value = true
}

/** 墙上手动挑一张开始框选式管理的时候，把用户送回左边那一列 —— 批量动作在那里 */
function onMenuSelect(id: string) {
  if (!id) return
  menu.value = null
  store.setColumnView('stickies')
  window.dispatchEvent(new CustomEvent('nota:sticky-select', { detail: id }))
}

async function onMenuCopy(id: string) {
  if (!id) return
  menu.value = null
  const text = await window.api.stickyText(id)
  if (!text.trim()) return toast('这张便签还是空的')
  try {
    await navigator.clipboard.writeText(text)
    toast('正文已复制')
  } catch {
    toast('剪贴板不可用')
  }
}

async function onMenuSave(id: string) {
  if (!id) return
  menu.value = null
  const r = await window.api.stickySaveToVault(id)
  if (!r.ok) return toast(r.error ?? '存不进去')
  touchStickies()
  toastUndo(`已存入 ${r.rel}`, () => void undoArchive([id]))
}

async function undoArchive(ids: string[]) {
  await window.api.stickyBatchPatch(ids, { closedAt: null })
  for (const id of ids) await window.api.stickyOpen(id)
  touchStickies()
}

async function onMenuReveal(id: string) {
  if (!id) return
  menu.value = null
  const ok = await window.api.stickyReveal(id)
  if (!ok) toast('这张便签还没写过字，磁盘上还没有文件')
}

/**
 * 墙上的删除不做两段式：先要右键、再点一次「删除」，路径已经比列表里
 * 那个一碰就中的红叉长得多，再加一道确认就是啰嗦。
 */
async function onMenuRemove(id: string) {
  if (!id) return
  menu.value = null
  await window.api.stickyDelete(id)
  dropFromStickies([id])
  touchStickies()
  toast('便签已删除')
}

async function commitRename(v: string) {
  renameOpen.value = false
  const id = actId.value
  if (!id || !v.trim()) return
  const r = await window.api.stickyRename(id, v)
  if (!r.ok) return toast(r.error ?? '改不了名字')
  touchStickies()
}

async function pickIcon(ic: { kind: 'brand' | 'emoji'; id: string } | null) {
  const id = actId.value
  if (!id) return
  await window.api.stickyPatch(id, { icon: ic })
  /* 不就地改 items 里那个对象：这期间任何一次 reloadStickies()（切视图、张数变化）
     都会把 items 换成新数组，手里的引用就作废了，改在一张没人再渲染的旧
     卡片上 —— 看着就是「设完图标，墙没变」。发信号，两边都重取一遍。 */
  touchStickies()
}

async function setTags(tags: string[]) {
  const id = actId.value
  if (!id) return
  await window.api.stickyPatch(id, { tags })
  touchStickies()
}

/** 卡片的纸色。整张铺满而不是只染一条边：一面墙上各种颜色的纸，是这一屏的气质 */
function cardStyle(s: StickyItem) {
  const p = paperOf(s.color)
  return {
    background: p.bg,
    color: p.fg,
    boxShadow: `0 0 0 1px ${p.dim}22, 0 1px 2px ${p.dim}33`,
  }
}

function dimStyle(s: StickyItem) {
  const p = paperOf(s.color)
  return { color: p.dim }
}

function hoverStyle(s: StickyItem) {
  const p = paperOf(s.color)
  return p.hover
}
</script>

<template>
  <div class="sb">
    <header class="sb-bar">
      <span class="sb-ic"><StickyNote :size="14" :stroke-width="1.9" /></span>
      <span class="sb-name">便签</span>
      <span class="sb-n">
        {{ items.length }} 张<template v-if="openCount"> · {{ openCount }} 张在桌面上</template>
      </span>

      <button
        class="sb-toggle"
        :class="{ on: onlyOpen }"
        role="switch"
        :aria-checked="onlyOpen"
        title="只显示桌面上开着的便签"
        @click="onlyOpen = !onlyOpen"
      >
        <span class="sb-knob" />
        <span class="sb-toggle-t">只看桌面上的</span>
      </button>

      <button class="sb-new" @click="create">
        <Plus :size="13" :stroke-width="2.4" />
        <span>新建便签</span>
      </button>

      <WindowControls />
    </header>

    <div class="sb-scroll">
      <div v-if="shown.length" class="sb-grid">
        <article
          v-for="s in shown"
          :key="s.id"
          class="sb-card"
          :class="{ archived: !!s.closedAt }"
          :style="cardStyle(s)"
          @click="open(s)"
          @contextmenu.prevent="onMenu($event, s)"
        >
          <div class="sb-top">
            <span class="sb-cico">
              <BrandGlyph v-if="s.icon?.kind === 'brand'" :id="s.icon.id" :size="17" />
              <span v-else-if="s.icon?.kind === 'emoji'" class="sb-emoji">{{ s.icon.id }}</span>
              <span v-else class="sb-seal" :style="dimStyle(s)"><span class="sb-seal-in" /></span>
            </span>
            <span class="sb-time" :style="dimStyle(s)">{{ relTime(s.updatedAt || s.createdAt) }}</span>
            <Check v-if="s.savedTo" class="sb-saved" :size="11" :stroke-width="2.8" />
          </div>

          <h3 class="sb-ctitle">{{ s.title }}</h3>
          <p v-if="s.preview" class="sb-cbody" :style="dimStyle(s)">{{ s.preview }}</p>

          <div v-if="s.tags?.length" class="sb-cfoot">
            <span v-for="t in s.tags.slice(0, 3)" :key="t" class="sb-ctag" :style="dimStyle(s)">
              #{{ t }}
            </span>
            <span v-if="s.tags.length > 3" class="sb-ctag" :style="dimStyle(s)">
              +{{ s.tags.length - 3 }}
            </span>
          </div>
        </article>
      </div>

      <div v-else-if="!loading" class="sb-empty">
        <StickyNote :size="26" :stroke-width="1.4" />
        <template v-if="onlyOpen && items.length">
          <p>桌面上没有开着的便签</p>
          <p class="sb-sub">{{ items.length }} 张都收在抽屉里，左边那一列可以展开</p>
          <button class="sb-empty-btn" @click="onlyOpen = false">看全部</button>
        </template>
        <template v-else-if="items.length">
          <p>还没有便签</p>
        </template>
        <template v-else>
          <p>这里会摊开你所有的便签</p>
          <p class="sb-sub">
            任何时候按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> 记一张，纸片就贴到这儿
          </p>
          <button class="sb-empty-btn" @click="create">
            <Plus :size="12" :stroke-width="2.4" />
            新建一张
          </button>
        </template>
      </div>
    </div>

    <StickyContextMenu
      :target="menu"
      @close="menu = null"
      @open="onMenuOpen"
      @rename="onMenuRename"
      @mark="onMenuMark"
      @select="onMenuSelect"
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
  </div>
</template>

<style scoped>
.sb {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--n-bg);
}

/* 顶栏和编辑区那一条同高（--n-topbar）：两个视图来回切，标题行不该上下跳 */
.sb-bar {
  flex: none;
  height: var(--n-topbar);
  display: flex;
  align-items: center;
  gap: 7px;
  padding-left: 14px;
  background: var(--n-surface);
  border-bottom: 1px solid var(--n-line);
  -webkit-app-region: drag;
}

.sb-ic {
  display: inline-flex;
  color: var(--n-fg-dim);
}
.sb-ic svg {
  fill: none;
  stroke: currentColor;
}

.sb-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--n-fg);
}

.sb-n {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--n-fg-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 开关：一颗小滑块 + 一句说明。用按钮而不是 checkbox，
   省掉一轮「默认控件的绿色」重写 */
.sb-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px 0 5px;
  border-radius: 999px;
  border: 1px solid var(--n-line);
  font-size: 11.5px;
  color: var(--n-fg-dim);
  -webkit-app-region: no-drag;
  transition:
    border-color 120ms ease,
    color 120ms ease;
}
.sb-toggle:hover {
  color: var(--n-fg);
}
.sb-toggle.on {
  border-color: color-mix(in oklab, var(--n-accent) 45%, transparent);
  color: var(--n-accent);
}
.sb-knob {
  width: 22px;
  height: 12px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--n-fg-faint) 34%, transparent);
  position: relative;
  transition: background 140ms ease;
}
.sb-knob::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--n-surface);
  transition: transform 140ms var(--n-ease);
}
.sb-toggle.on .sb-knob {
  background: var(--n-accent);
}
.sb-toggle.on .sb-knob::after {
  transform: translateX(10px);
}
.sb-toggle-t {
  white-space: nowrap;
}

/* 主区顶上的「新建便签」不用实心色块：资料栏顶上已经有同一个入口，
   两个都喊就会互相抢。这里它是次要动作，用线框，悬停才亮 */
.sb-new {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--n-line);
  background: transparent;
  color: var(--n-fg-dim);
  font-size: 11.5px;
  -webkit-app-region: no-drag;
  transition:
    background 120ms var(--n-ease),
    color 120ms var(--n-ease),
    border-color 120ms var(--n-ease);
}
.sb-new svg {
  fill: none;
  stroke: currentColor;
}
.sb-new:hover {
  background: var(--n-raised);
  border-color: var(--n-line-strong, var(--n-line));
  color: var(--n-fg);
}

.sb-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px 28px;
}

/* 卡片流：列宽自适应，窗口窄了并成两列而不是压扁每一张。
   align-content: start —— 不然卡片少的时候整片会垂直居中，顶上留一大块空 */
.sb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
  gap: 14px;
  align-content: start;
  /* 每张纸按自己的内容高，不拉齐到同一行最高的那张：
     拉齐会在只有一行字的纸底下留一大块空白，像没排完版 */
  align-items: start;
}

/* 一张纸。
   高度跟着内容走（min-height 兜住只有一行字的那些）。放在墙上的纸本来就
   长短不一，硬拉成一样高反而露出假：短的那张下半截是空的。
   标签用 margin-top:auto —— 内容高过 min-height 时它自然贴在底边。 */
.sb-card {
  position: relative;
  min-height: 108px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px 11px;
  border-radius: 10px;
  cursor: default;
  overflow: hidden;
  transition:
    transform 150ms var(--n-ease),
    box-shadow 150ms var(--n-ease),
    filter 150ms var(--n-ease);
}
.sb-card:hover {
  transform: translateY(-2px);
  filter: brightness(1.015);
}
.sb-card:active {
  transform: translateY(0);
}
/* 收起的那批：还在墙上，但轻一档 —— 不是「不在了」，是「不在这会儿」 */
.sb-card.archived {
  opacity: 0.84;
}
.sb-card.archived:hover {
  opacity: 1;
}

.sb-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 18px;
}

.sb-cico {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
}

.sb-emoji {
  font-size: 14px;
  line-height: 1;
}

/* 没挂图标时的一枚火漆印：比纸色深一档的空心圆，安静地占住那个位置 */
.sb-seal {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  display: grid;
  place-items: center;
  opacity: 0.55;
}
.sb-seal-in {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}

.sb-time {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  text-align: right;
  opacity: 0.85;
  white-space: nowrap;
}

.sb-saved {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-accent);
}

.sb-ctitle {
  flex: none;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-cbody {
  flex: none;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  overflow: hidden;
  /* 五行装不下就截断：再多就不是「看一眼认出来」，而是站在墙前面读字 */
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  word-break: break-word;
}

.sb-cfoot {
  flex: none;
  display: flex;
  gap: 7px;
  height: 14px;
  margin-top: auto;
  overflow: hidden;
}

.sb-ctag {
  flex: none;
  max-width: 42%;
  font-size: 10.5px;
  line-height: 14px;
  opacity: 0.9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 72px 24px;
  text-align: center;
  color: var(--n-fg-dim);
}
.sb-empty svg {
  fill: none;
  stroke: currentColor;
  opacity: 0.6;
}
.sb-empty p {
  margin: 0;
  font-size: 13px;
}
.sb-empty .sb-sub {
  font-size: 11.5px;
  line-height: 1.7;
  opacity: 0.8;
}
.sb-empty kbd {
  display: inline-block;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  font-family: inherit;
  font-size: 10.5px;
}
.sb-empty-btn {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--n-line);
  font-size: 12px;
  color: var(--n-fg);
}
.sb-empty-btn svg {
  fill: none;
  stroke: currentColor;
  opacity: 1;
}
.sb-empty-btn:hover {
  background: var(--n-surface);
}
</style>
