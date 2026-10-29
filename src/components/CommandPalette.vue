<script setup lang="ts">
/**
 * 命令面板（Ctrl+K）。
 *
 * 存在的理由不是「多一个炫技的输入框」，而是一个具体的病：
 * Nota 到 2.7.15 已经有十一类功能，但各自藏在侧栏某一项、工具栏某一颗、
 * 或者某个只有自己知道的快捷键里。用户不是不用，是想不起来。
 * 所以这里**不加任何新功能**，只是把已有的排成一列，让它们都能被搜到。
 *
 * 一个框干两件事：搜命令、搜笔记。为什么不学 VS Code 用 `>` 前缀分模式 ——
 * 前缀是个要先知道的规则，而这里要解决的恰恰是「不知道有什么」。
 * 打字就打，出来什么算什么：命令在前、笔记在后。
 *
 * 空输入时先给「最近用过」：这个面板必须越用越顺，否则每次都要重新找。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CornerDownLeft, FileText, Search, SquareTerminal, X } from 'lucide-vue-next'
import { store } from '@/store'
import { cmdEnabled, matchCommands, type Command } from '@/commands'
import { remember as persist, setting } from '@/store/settings'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { state } = store

const RECENT_KEY = 'nota.cmdk.recent'
const RECENT_MAX = 6

/* 「最近用过的命令」跟库走：它记的是命令 id，不是本机路径，
   换台电脑打开同一个库也该还是那几条顺手的位置 */
function loadRecent(): string[] {
  const raw = setting<unknown>(RECENT_KEY, [])
  return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : []
}

function saveRecent(ids: string[]) {
  persist(RECENT_KEY, ids)
}

const q = ref('')
const cursor = ref(0)
const recent = ref<string[]>(loadRecent())
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const query = computed(() => q.value.trim())

/* 命令：空输入时给全部（最近用过的浮在前面），有输入时按匹配度排 */
const cmdHits = computed<Command[]>(() => matchCommands(query.value, recent.value))

const recentSet = computed(() => new Set(recent.value))
/** 空输入时，列表前面这一段是「最近用过」，用来画分隔标题 */
const recentCount = computed(() =>
  query.value ? 0 : cmdHits.value.filter((c) => recentSet.value.has(c.id)).length,
)

type FileRow = { name: string; path: string }

function rel(p: string) {
  const root = state.root ?? ''
  const s = root && p.startsWith(root) ? p.slice(root.length) : p
  return s.replace(/^[\\/]+/, '')
}

function folderOf(p: string) {
  const parts = rel(p).split(/[\\/]/)
  parts.pop()
  return parts.join(' / ') || '根目录'
}

/* 笔记只比标题和路径。正文搜索是 Ctrl+Shift+F 那条路 ——
   在这个框里连带读几百篇磁盘，输入就会被拖住。 */
const noteHits = computed<FileRow[]>(() => {
  const s = query.value.toLowerCase()
  if (!s) return []
  return (store.allFiles.value as FileRow[])
    .filter((f) => f.name.toLowerCase().includes(s) || rel(f.path).toLowerCase().includes(s))
    .slice(0, 8)
})

const total = computed(() => cmdHits.value.length + noteHits.value.length)

function move(d: number) {
  if (!total.value) return
  cursor.value = (cursor.value + d + total.value) % total.value
  nextTick(() => {
    listEl.value?.querySelector<HTMLElement>('.cp-row.on')?.scrollIntoView({ block: 'nearest' })
  })
}

function remember(id: string) {
  recent.value = [id, ...recent.value.filter((x) => x !== id)].slice(0, RECENT_MAX)
  saveRecent(recent.value)
}

function pick(i: number) {
  const c = cmdHits.value[i]
  if (c) {
    if (!cmdEnabled(c)) return
    remember(c.id)
    // 先关自己再执行：有些命令会开另一个浮层（全文搜索、设置、版本历史），
    // 反过来的话新浮层会被这一下的关闭动画压在下面。
    emit('close')
    void Promise.resolve(c.run()).catch(() => {
      /* 命令里抛错不该让面板崩掉，静默即可 */
    })
    return
  }
  const f = noteHits.value[i - cmdHits.value.length]
  if (f) {
    void store.openNote(f.path)
    emit('close')
  }
}

/**
 * 键盘处理挂在 document 上，不挂在输入框上。
 *
 * 挂输入框上踩过一个坑：焦点一旦离开输入框（点了列表某一项、鼠标滚了一下、
 * 切了窗口回来），Esc 就按不掉了 —— 面板明明还在屏幕上。这跟「Esc 只属于输入框」
 * 的直觉相反，但对用户来说就是「它卡住了」。
 *
 * 挂 document 就必须自己判断开关状态：组件是常驻的（v-if 在里面），
 * 收起来的那些时刻如果照旧处理 Enter，会在没人看得见的地方执行第一条命令。
 */
function onKey(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (total.value) pick(cursor.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => document.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))

watch(
  () => props.open,
  (v) => {
    if (!v) return
    q.value = ''
    cursor.value = 0
    recent.value = loadRecent()
    nextTick(() => inputEl.value?.focus())
  },
)

watch(
  () => q.value,
  () => {
    cursor.value = 0
  },
)

/** 置灰的那些不执行，但要能看见 —— 藏起来等于告诉用户「没这个功能」 */
function blocked(c: Command) {
  return !cmdEnabled(c)
}
</script>

<template>
  <div v-if="open" class="cp-mask" @pointerdown.self="emit('close')">
    <div class="cp" role="dialog" aria-label="命令面板">
      <div class="cp-head">
        <span class="cp-ico">
          <SquareTerminal :size="14" :stroke-width="1.9" />
        </span>
        <input
          ref="inputEl"
          v-model="q"
          class="cp-input"
          type="text"
          placeholder="输入命令，或直接打字找笔记…"
          spellcheck="false"
        />
        <button class="cp-x" aria-label="关闭" @click="emit('close')">
          <X :size="14" :stroke-width="1.9" />
        </button>
      </div>

      <div ref="listEl" class="cp-list">
        <template v-for="(c, i) in cmdHits" :key="c.id">
          <div v-if="i === 0" class="cp-sec">
            {{ recentCount ? '最近用过' : query ? '命令' : '全部命令' }}
          </div>
          <div v-if="recentCount && i === recentCount" class="cp-sec">全部命令</div>
          <button
            class="cp-row"
            :class="{ on: cursor === i, off: blocked(c) }"
            @pointerenter="cursor = i"
            @click="pick(i)"
          >
            <span class="cp-ico"><component :is="c.icon" :size="14" :stroke-width="1.9" /></span>
            <span class="cp-title">{{ c.title }}</span>
            <span v-if="blocked(c)" class="cp-hint">先打开一篇笔记</span>
            <span v-else-if="c.hint" class="cp-kbd">{{ c.hint }}</span>
            <span v-else class="cp-hint">{{ c.group }}</span>
          </button>
        </template>

        <template v-if="noteHits.length">
          <div class="cp-sec">笔记</div>
          <button
            v-for="(f, k) in noteHits"
            :key="f.path"
            class="cp-row"
            :class="{ on: cursor === cmdHits.length + k }"
            @pointerenter="cursor = cmdHits.length + k"
            @click="pick(cmdHits.length + k)"
          >
            <span class="cp-ico"><FileText :size="14" :stroke-width="1.9" /></span>
            <span class="cp-title">{{ f.name.replace(/\.md$/i, '') }}</span>
            <span class="cp-hint">{{ folderOf(f.path) }}</span>
          </button>
        </template>

        <p v-if="!total" class="cp-empty">
          没有匹配的命令或笔记。Ctrl+Shift+F 可以连正文一起搜。
        </p>
      </div>

      <div class="cp-foot">
        <span class="cp-key"><CornerDownLeft :size="11" :stroke-width="2" /> 执行</span>
        <span class="cp-key">↑↓ 选择</span>
        <span class="cp-key">Esc 关闭</span>
        <span class="cp-hint cp-tail">
          <Search :size="11" :stroke-width="2" /> 命令和笔记都能搜
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp-mask {
  position: fixed;
  inset: 0;
  /* 压在设置 / 版本历史（都是 1000）之上，只在 Toast（2000）之下：
     这两个面板开着的时候按 Ctrl+K，面板也得看得见 ——
     否则会出现「屏幕上什么都没变，但按 Esc 会关掉一个看不见的东西」。 */
  z-index: 1100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: var(--n-mask);
}
.cp {
  width: 600px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  max-height: 68vh;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-raised);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
}
.cp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--n-line);
}
.cp-ico {
  display: inline-flex;
  flex: none;
  color: var(--n-fg-faint);
}
.cp-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--n-fg);
  font-family: inherit;
  font-size: 13.5px;
  outline: none;
}
.cp-input::placeholder {
  color: var(--n-fg-faint);
}
.cp-x {
  padding: 3px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--n-fg-faint);
  cursor: pointer;
}
.cp-x:hover {
  background: var(--n-hover);
  color: var(--n-fg);
}
.cp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.cp-sec {
  padding: 6px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--n-fg-faint);
}
.cp-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--n-r-sm);
  background: transparent;
  color: var(--n-fg);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.cp-row.on {
  background: var(--n-active);
}
.cp-row.off {
  opacity: 0.42;
  cursor: default;
}
.cp-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-hint {
  flex: none;
  font-size: 11.5px;
  color: var(--n-fg-faint);
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-kbd {
  flex: none;
  padding: 1px 5px;
  border: 1px solid var(--n-line);
  border-radius: 4px;
  font-size: 11px;
  color: var(--n-fg-faint);
}
.cp-empty {
  margin: 10px 8px;
  font-size: 12px;
  color: var(--n-fg-faint);
}
.cp-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 14px;
  border-top: 1px solid var(--n-line);
  font-size: 11px;
  color: var(--n-fg-faint);
}
.cp-key {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.cp-tail {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
