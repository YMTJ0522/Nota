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
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Archive,
  Check,
  FolderOpen,
  Plus,
  StickyNote,
  Trash2,
} from 'lucide-vue-next'
import { store } from '@/store'

const items = ref<StickyItem[]>([])
const loading = ref(false)
/** 已归档的默认收起来：桌面上真正在用的一般就那么几张，历史不该占满一屏 */
const showArchived = ref(false)
/** 正在等着二次确认的那一条 */
const confirming = ref<string | null>(null)
let confirmTimer = 0

const openList = computed(() => items.value.filter((s) => !s.closedAt))
const archivedList = computed(() => items.value.filter((s) => s.closedAt))
const visible = computed(() => (showArchived.value ? items.value : openList.value))

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

async function create() {
  const r = await window.api.stickyNew()
  if ('error' in r) toast(r.error)
  else void load()
}

async function closeAll() {
  const n = await window.api.stickyCloseAll()
  if (n > 0) toast(`已收起 ${n} 张便签`)
  void load()
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

async function reveal() {
  await window.api.revealStickies()
}
</script>

<template>
  <section class="sv">
    <div class="sv-tools">
      <button class="sv-btn primary" @click="create">
        <Plus :size="14" :stroke-width="2.2" /><span>新便签</span>
      </button>
      <button
        class="sv-btn"
        :disabled="openList.length === 0"
        title="把桌面上的便签都收起来"
        @click="closeAll"
      >
        收起全部
      </button>
      <button class="sv-ico" title="打开便签文件夹" @click="reveal">
        <FolderOpen :size="14" :stroke-width="1.9" />
      </button>
    </div>

    <!-- 快捷键提示放这一行而不是空态里：用的人知道有捷径，能少点一次创作
         这一排按钮。没快捷键的时候（被别的程序占了）这句就自动消失。 -->
    <p class="sv-tip">
      任何时候按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> 记一张，连按可以连开
    </p>

    <div class="sv-list">
      <button
        v-for="s in visible"
        :key="s.id"
        class="sv-item"
        :class="{ archived: !!s.closedAt }"
        @click="open(s)"
      >
        <div class="sv-head">
          <span class="sv-title">{{ s.title }}</span>
          <span class="sv-time">{{ when(s.updatedAt || s.createdAt) }}</span>
        </div>
        <p v-if="s.preview" class="sv-prev">{{ s.preview }}</p>
        <div class="sv-meta">
          <span v-if="s.closedAt" class="sv-tag"><Archive :size="11" :stroke-width="2" />已收起</span>
          <span v-if="s.savedTo" class="sv-tag ok" :title="`已存入 ${s.savedTo}`">
            <Check :size="11" :stroke-width="2.4" />{{ s.savedTo.split('/').pop() }}
          </span>
          <span v-if="s.chars" class="sv-tag plain">{{ s.chars }} 字</span>
        </div>
        <span
          class="sv-del"
          :class="{ confirm: confirming === s.id }"
          :title="confirming === s.id ? '再点一次就删掉' : '删除'"
          @click.stop="remove(s)"
        >
          <Trash2 :size="12" :stroke-width="2" />
        </span>
      </button>

      <div v-if="!loading && visible.length === 0" class="sv-empty">
        <StickyNote :size="22" :stroke-width="1.5" />
        <p>还没有便签</p>
        <p class="sub">按 Ctrl+Alt+N 随手记一张，写完点右上角的按钮存进笔记</p>
      </div>
    </div>

    <button
      v-if="archivedList.length"
      class="sv-more"
      @click="showArchived = !showArchived"
    >
      {{ showArchived ? `只看开着的（${openList.length}）` : `已收起 ${archivedList.length} 张` }}
    </button>
  </section>
</template>

<style scoped>
.sv {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.sv-tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px 7px;
}

.sv-btn {
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 9px;
  border-radius: 7px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  color: var(--n-fg);
  font-size: 12px;
  transition: background 130ms ease, border-color 130ms ease;
}
.sv-btn:hover:not(:disabled) {
  background: var(--n-hover, var(--n-surface));
}
.sv-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.sv-btn.primary {
  background: var(--n-accent);
  border-color: var(--n-accent);
  color: #fff;
}
.sv-btn.primary:hover {
  background: var(--n-accent);
  filter: brightness(1.06);
}

.sv-ico {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  margin-left: auto;
  border-radius: 7px;
  color: var(--n-fg-dim);
}
.sv-ico:hover {
  background: var(--n-hover, var(--n-surface));
  color: var(--n-fg);
}

.sv-tip {
  flex: none;
  margin: 0;
  padding: 0 12px 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--n-fg-dim);
}
.sv-tip kbd {
  display: inline-block;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  font-family: inherit;
  font-size: 10.5px;
}

.sv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.sv-item {
  position: relative;
  width: 100%;
  display: block;
  text-align: left;
  padding: 8px 30px 8px 10px;
  border-radius: 8px;
  transition: background 130ms ease;
}
.sv-item:hover {
  background: var(--n-hover, var(--n-surface));
}
/* 收起的那批压暗一档：它们还在，但不是当下在用的 */
.sv-item.archived {
  opacity: 0.62;
}
.sv-item.archived:hover {
  opacity: 0.9;
}

.sv-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
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
  margin: 2px 0 0;
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
  margin-top: 4px;
  flex-wrap: wrap;
}
.sv-meta:empty {
  display: none;
}

.sv-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--n-surface);
  color: var(--n-fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sv-tag.ok {
  color: var(--n-accent);
  background: color-mix(in oklab, var(--n-accent) 12%, transparent);
}
.sv-tag.plain {
  background: transparent;
  padding: 0;
}

/* 删除按钮平时藏着，鼠标停上去才出现：列表一屏十几条，每条都挂一个红叉
   会让整列看起来很吵 */
.sv-del {
  position: absolute;
  top: 7px;
  right: 6px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--n-fg-dim);
  opacity: 0;
  transition: opacity 130ms ease, background 130ms ease, color 130ms ease;
}
.sv-item:hover .sv-del {
  opacity: 1;
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
  padding: 42px 22px;
  color: var(--n-fg-dim);
  text-align: center;
}
.sv-empty p {
  margin: 0;
  font-size: 12.5px;
}
.sv-empty .sub {
  font-size: 11.5px;
  line-height: 1.55;
  opacity: 0.85;
}

.sv-more {
  flex: none;
  height: 32px;
  margin: 0 10px 8px;
  border-radius: 7px;
  border: 1px dashed var(--n-line);
  color: var(--n-fg-dim);
  font-size: 11.5px;
  transition: background 130ms ease, color 130ms ease;
}
.sv-more:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}
</style>
