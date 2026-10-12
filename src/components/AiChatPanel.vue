<script setup lang="ts">
/**
 * AI 编写：住在中间那一列里的 agent 面板。
 *
 * 它是 agent，不是聊天框。差别不在话术，在于「看得见它在干什么」：
 *
 * · 顶上那张卡片说明它盯的是哪一篇笔记（可以换、可以关掉）；
 * · 「执行过程」是这一轮真做过的事 —— 读了哪篇、上下文怎么截的、
 *   调用了哪个模型、收回多少字，每一步都带真实耗时；
 * · 「思考过程」是模型自己吐出来的推理，边生成边往外流。
 *   模型不返回推理时这一行直接不出现，而不是摆一行空的充数。
 *
 * 布局照参考图来：卡片 → 指令行 → 笔记开关与选择 → 消息流 →
 * 快捷指令 → 输入区 → 底部的模型与会话。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowUp,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Cpu,
  FilePlus2,
  Heading1,
  Languages,
  ListChecks,
  ListTree,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-vue-next'
import { AI_PRESETS, store } from '@/store'
import type { ChatMessage } from '@/store'
import { markdownToHtml } from '@/editor/markdown'
import { renderMathInHtml, renderMermaidInHtml } from '@/editor/preview-rich'

const { state } = store

const scroller = ref<HTMLDivElement | null>(null)
const box = ref<HTMLTextAreaElement | null>(null)
const draft = ref('')
/** 已渲染的消息 HTML：id → html */
const rendered = ref<Record<number, string>>({})
/** 这份 HTML 属于哪个会话。切会话时整段重渲染 */
const renderedSid = ref(-1)
const copied = ref(0)
/** 顶上那张「AI 助手」卡片关掉后只留一条细边，点它再展开 */
const cardOpen = ref(true)
/** 每一段折叠区自己记状态：`<消息 id>:think` / `<消息 id>:steps` */
const secOpen = ref<Record<string, boolean>>({})

const modelLabel = computed(() => state.ai.model || '未配置模型')
const noteLabel = computed(() => store.aiTargetName.value)
const lastId = computed(() => state.chat[state.chat.length - 1]?.id ?? 0)
const lastMsg = computed(() => state.chat[state.chat.length - 1])

/** 最近的指令：顶上那一行显示的就是它 */
const lastAsk = computed(() => {
  for (let i = state.chat.length - 1; i >= 0; i -= 1) {
    if (state.chat[i].role === 'user') return state.chat[i].content
  }
  return ''
})

/** 卡片副标题：把「它现在在干什么」说清楚 */
const cardSub = computed(() => {
  if (state.aiBusy) return state.aiStage
  if (!state.aiWithNote) return '只回答问题，不带笔记正文'
  return `正在处理整篇笔记 · ${noteLabel.value}`
})

const canSend = computed(() => draft.value.trim().length > 0 && !state.aiBusy)

/** 会话列表按最近发言倒序，跟大多数聊天工具一致 */
const sessions = computed(() =>
  [...state.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
)

const activeSessionTitle = computed(
  () =>
    state.sessions.find((s) => s.id === state.activeSessionId)?.title ??
    (state.sessions.length ? '未命名会话' : '新对话'),
)

/* ── 消息渲染 ──
   流式回答时长一直在变，不能每来一个字就重排一遍 Markdown 再高亮一次。
   攒 140ms 渲染一次，视觉上还是「一个字一个字往外冒」。 */
let renderTimer: ReturnType<typeof setTimeout> | null = null

async function renderMessage(id: number, content: string) {
  try {
    const { html } = await markdownToHtml(content)
    rendered.value = { ...rendered.value, [id]: html }
  } catch {
    rendered.value = { ...rendered.value, [id]: '' }
  }
}

function scheduleRender(id: number, content: string) {
  if (renderTimer) return
  renderTimer = setTimeout(() => {
    renderTimer = null
    void (async () => {
      await renderMessage(id, content)
      await nextTick()
      if (pinned) scrollToEnd()
    })()
  }, 140)
}

/** 流式期间贴住底部；用户往上翻就先别拽他回底部 */
let pinned = true

function onScroll() {
  const el = scroller.value
  if (!el) return
  pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 48
}

function scrollToEnd() {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 会话一换、消息一多、回答一长，都在这里被接住 */
const streamKey = computed(() => {
  const last = lastMsg.value
  return `${state.activeSessionId}|${state.chat.length}|${last?.id ?? 0}.${last?.content.length ?? 0}`
})

watch(
  streamKey,
  async () => {
    if (renderedSid.value !== state.activeSessionId) {
      renderedSid.value = state.activeSessionId
      rendered.value = {}
      for (const m of state.chat) {
        if (m.role === 'assistant' && !m.error) await renderMessage(m.id, m.content)
      }
      await nextTick()
      pinned = true
      scrollToEnd()
      await paintRich()
      return
    }

    const last = lastMsg.value
    if (last && last.role === 'assistant' && !last.error) {
      if (rendered.value[last.id] === undefined) await renderMessage(last.id, last.content)
      else if (state.aiBusy) scheduleRender(last.id, last.content)
    }
    await nextTick()
    if (pinned) scrollToEnd()
    // 公式与图表等回答停了再排：它们比 Markdown 贵得多，流式期间排没意义
    if (!state.aiBusy) await paintRich()
  },
  { immediate: true },
)

/** 把 KaTeX 与 Mermaid 填进已经渲染好的消息里 */
async function paintRich() {
  const el = scroller.value
  if (!el) return
  await renderMathInHtml(el)
  await renderMermaidInHtml(el)
}

/* ── 模型选择 ── */
const modelMenu = ref(false)
const modelLoading = ref(false)
const serverModels = ref<string[]>([])
const modelsFetched = ref(false)

const modelOptions = computed(() => {
  const set = new Set<string>()
  const cur = state.ai.model.trim()
  if (cur) set.add(cur)
  for (const m of serverModels.value) if (m) set.add(m)
  for (const p of AI_PRESETS) set.add(p.model)
  return [...set]
})

async function loadModels(force = false) {
  if (modelLoading.value) return
  if (modelsFetched.value && !force) return
  modelLoading.value = true
  try {
    const r = await window.api.aiTest({ ...state.ai })
    if (r.ok) {
      serverModels.value = r.models ?? []
      modelsFetched.value = true
    }
  } catch {
    /* 拉不到就只用预设，不打断对话 */
  } finally {
    modelLoading.value = false
  }
}

function toggleModel() {
  modelMenu.value = !modelMenu.value
  if (modelMenu.value) void loadModels()
}

function pickModel(m: string) {
  store.setAiConfig({ model: m })
  modelMenu.value = false
}

/* ── 笔记选择 ── */
const noteMenu = ref(false)
const sessMenu = ref(false)

const noteOptions = computed(() => store.allFiles.value)

function pickNote(path: string | null) {
  store.setAiNote(path)
  noteMenu.value = false
}

/** 点别处 / Esc 收起所有就地弹出的菜单 */
function onDocPointer(e: PointerEvent) {
  const el = e.target as HTMLElement
  if (!el.closest('.m-wrap')) modelMenu.value = false
  if (!el.closest('.np-wrap')) noteMenu.value = false
  if (!el.closest('.ss-wrap')) sessMenu.value = false
}

function onEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  modelMenu.value = false
  noteMenu.value = false
  sessMenu.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onEsc)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onEsc)
  if (renderTimer) clearTimeout(renderTimer)
})

/* ── 折叠区 ── */
function secIsOpen(id: number, kind: 'think' | 'steps') {
  const k = `${id}:${kind}`
  // 跑的时候默认摊开让人看见它在干什么，跑完收回参考图那种一行
  return secOpen.value[k] ?? (state.aiBusy && id === lastId.value)
}

function toggleSec(id: number, kind: 'think' | 'steps') {
  const k = `${id}:${kind}`
  secOpen.value[k] = !secIsOpen(id, kind)
}

/* ── 会话 ── */
function when(ts: number) {
  const d = new Date(ts || Date.now())
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

async function pickSession(id: number) {
  sessMenu.value = false
  if (id === state.activeSessionId) return
  store.switchSession(id)
  await nextTick()
  pinned = true
  scrollToEnd()
}

async function createSession() {
  sessMenu.value = false
  store.newChat()
  await nextTick()
  box.value?.focus()
}


/* ── 输入 ── */
function autoGrow() {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}

async function send() {
  if (!canSend.value) return
  const text = draft.value
  draft.value = ''
  await nextTick()
  autoGrow()
  pinned = true
  await store.sendChat(text)
}

function onKey(e: KeyboardEvent) {
  // Enter 发送、Shift+Enter 换行——和所有聊天工具一致
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

/** 快捷指令：点一下填进输入框而不是直接发送 —— 留一次反悔的机会 */
const CHIPS: { label: string; icon: unknown; text: string }[] = [
  { label: '总结全文', icon: Sparkles, text: '把当前这篇笔记总结成要点列表。' },
  { label: '生成大纲', icon: ListTree, text: '给当前这篇笔记整理一份三级大纲。' },
  { label: '起标题', icon: Heading1, text: '根据内容给这篇笔记起一个正式的标题。' },
  { label: '润色', icon: Wand2, text: '润色当前笔记，使其更通顺、专业，保留原意。' },
  { label: '译成英文', icon: Languages, text: '把当前笔记翻译成英文，保留 Markdown 结构。' },
]

function useChip(text: string) {
  draft.value = text
  nextTick(() => {
    box.value?.focus()
    autoGrow()
  })
}

/* ── 消息上的动作 ── */
function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

function insertToNote(content: string) {
  if (!state.activePath) {
    toast('先打开一篇笔记，再插入')
    return
  }
  window.dispatchEvent(new CustomEvent('nota:insert', { detail: `\n${content}\n` }))
  toast('已插入到当前笔记')
}

async function copyMessage(id: number, content: string) {
  try {
    await navigator.clipboard.writeText(content)
    copied.value = id
    setTimeout(() => {
      if (copied.value === id) copied.value = 0
    }, 1400)
  } catch {
    toast('复制失败')
  }
}

/** 把这条回答单独存成一篇新笔记，放在当前笔记旁边 */
async function saveAsNote(content: string) {
  const dir = state.activePath
    ? state.activePath.replace(/[\\/][^\\/]+$/, '')
    : state.root
  if (!dir) {
    toast('还没有打开工作区')
    return
  }
  try {
    const path = await window.api.createNote(dir, lastAsk.value.slice(0, 20) || 'AI 回复')
    await window.api.writeNote(path, content)
    await store.refreshTree()
    await store.openNote(path)
    toast('已存成一篇新笔记')
  } catch {
    toast('存成新笔记失败')
  }
}

function openAiSettings() {
  window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'ai' }))
}

/** 思考过程是一段一段流进来的，末尾跟着一个闪烁光标才像「正在想」 */
const thinkingLive = computed(
  () => state.aiBusy && lastMsg.value?.role === 'assistant' && !!lastMsg.value?.thinking,
)
</script>

<template>
  <div class="ag">
    <!-- ① 这张卡片回答「它在为谁干活」：盯哪一篇、要不要带正文、可以关掉 -->
    <div v-if="cardOpen" class="ag-card">
      <span class="ag-avatar"><Bot :size="15" :stroke-width="1.9" /></span>
      <span class="ag-id">
        <span class="ag-name">AI 助手</span>
        <span class="ag-sub">{{ cardSub }}</span>
      </span>
      <button class="ag-x" title="收起上方设定" @click="cardOpen = false">
        <X :size="13" :stroke-width="2.2" />
      </button>
    </div>

    <template v-else>
      <button class="ag-stub" @click="cardOpen = true">
        <Bot :size="12" :stroke-width="1.9" />
        <span>AI 助手设定</span>
        <ChevronRight :size="11" :stroke-width="2" />
      </button>
    </template>

    <!-- ② 会话行：这一栏在跟谁对话 —— 左边选会话，右边新建 / 删掉当前这个。
         参考图里这一格显示的就是「这次对话在聊什么」，因为会话名就是第一条指令。 -->
    <div class="ag-sess">
      <div class="ss-wrap">
        <button
          class="ag-sess-pick"
          :class="{ on: sessMenu, dim: state.chat.length === 0 }"
          :title="`会话：${activeSessionTitle}`"
          @click="sessMenu = !sessMenu"
        >
          <MessageSquare :size="12" :stroke-width="1.9" />
          <span class="ag-sess-name">{{ activeSessionTitle }}</span>
          <ChevronDown :size="11" :stroke-width="2" />
        </button>

        <div v-if="sessMenu" class="n-menu n-menu-inline ss-menu">
          <!-- 列表开着的时候，开新会话这一步就在手边，不用先收起列表再去找那一枚 + -->
          <div class="n-menu-head">
            <span>会话</span>
            <span class="n-menu-head-acts">
              <button class="ag-mini" title="新建会话" @click="createSession">
                <Plus :size="12" :stroke-width="2.2" />
              </button>
            </span>
          </div>
          <button
            v-for="s in sessions"
            :key="s.id"
            class="n-menu-item"
            :class="{ on: s.id === state.activeSessionId }"
            @click="pickSession(s.id)"
          >
            <span class="n-menu-name">{{ s.title }}</span>
            <span class="n-menu-tail">{{ when(s.updatedAt) }}</span>
          </button>
        </div>
      </div>

      <button class="ag-mini" title="新建会话" @click="createSession">
        <Plus :size="12" :stroke-width="2.2" />
      </button>
      <button
        class="ag-mini danger"
        title="删除当前会话"
        @click="store.deleteSession(state.activeSessionId)"
      >
        <Trash2 :size="12" :stroke-width="1.9" />
      </button>
    </div>

    <!-- ③ 上下文：开关打开＝选中笔记（正文一起交给模型），关掉＝不选笔记、自由聊天 -->
    <div class="ag-note">
      <button
        class="ag-switch"
        :class="{ on: state.aiWithNote }"
        role="switch"
        :aria-checked="state.aiWithNote"
        :title="state.aiWithNote ? '带笔记：这一轮会把笔记正文一起交给模型' : '自由对话：这一轮只带对话本身'"
        @click="store.setAiWithNote(!state.aiWithNote)"
      >
        <span class="ag-knob" />
      </button>

      <!-- 关掉开关就没有「选中的笔记」可言，直接说清楚现在是在自由聊天 -->
      <span v-if="!state.aiWithNote" class="ag-note-label">自由对话</span>

      <!-- 选中笔记的时候才需要挑是哪一篇 -->
      <div v-else class="np-wrap">
        <button class="ag-pick" :class="{ on: noteMenu }" :title="`工作对象：${noteLabel}`" @click="noteMenu = !noteMenu">
          <span class="ag-pick-name">{{ noteLabel }}</span>
          <ChevronDown :size="11" :stroke-width="2" />
        </button>

        <div v-if="noteMenu" class="n-menu n-menu-inline np-menu">
          <div class="n-menu-head"><span>让 AI 处理哪一篇</span></div>
          <button
            v-if="state.aiNote"
            class="n-menu-item"
            :class="{ on: !state.aiNote }"
            @click="pickNote(null)"
          >
            <span class="n-menu-name">跟随当前打开的笔记</span>
          </button>
          <button
            v-for="f in noteOptions"
            :key="f.path"
            class="n-menu-item"
            :class="{ on: (state.aiNote ?? state.activePath) === f.path }"
            :title="f.path"
            @click="pickNote(f.path)"
          >
            <span class="n-menu-name">{{ f.name.replace(/\.md$/i, '') }}</span>
            <Check v-if="(state.aiNote ?? state.activePath) === f.path" :size="12" :stroke-width="2.2" />
          </button>
          <p v-if="noteOptions.length === 0" class="n-menu-hint">工作区里还没有笔记</p>
        </div>
      </div>
    </div>

    <!-- ④ 消息流 -->
    <div ref="scroller" class="stream" @scroll.passive="onScroll">
      <div v-if="state.chat.length === 0" class="ag-empty">
        <p class="ag-empty-title">让 AI 帮你写</p>
        <p class="ag-empty-sub">
          对话走本机配置的模型（{{ modelLabel }}），也可以接云端 —— 在
          <button class="link" @click="openAiSettings">AI 编写设置</button> 里改。
        </p>
      </div>

      <div v-for="m in state.chat" :key="m.id" class="row" :class="m.role">
        <!-- 我说的：靠右，气泡 -->
        <template v-if="m.role === 'user'">
          <span class="who">你</span>
          <div class="bubble">{{ m.content }}</div>
        </template>

        <!-- 它说的：靠左，一段一段摊开，不用气泡裹住 -->
        <template v-else>
          <span class="who asst">AI 助手</span>

          <div v-if="m.error" class="err">
            <p class="err-text">{{ m.error }}</p>
            <button class="err-btn" @click="store.retryChat()">
              <RefreshCw :size="12" :stroke-width="2" /><span>重试</span>
            </button>
          </div>

          <template v-else>
            <!-- 思考过程：模型自己吐的推理。没有就整行不出现，不摆空壳 -->
            <div v-if="m.thinking" class="sec">
              <button class="sec-head" :aria-expanded="secIsOpen(m.id, 'think')" @click="toggleSec(m.id, 'think')">
                <ChevronRight class="sec-caret" :class="{ open: secIsOpen(m.id, 'think') }" :size="11" :stroke-width="2.2" />
                <BrainCircuit :size="12" :stroke-width="1.9" />
                <span>思考过程</span>
                <span class="sec-tail">{{ m.thinking.length }} 字</span>
              </button>
              <div v-show="secIsOpen(m.id, 'think')" class="sec-body think">
                {{ m.thinking }}<span v-if="thinkingLive && m.id === lastId" class="caret" />
              </div>
            </div>

            <!-- 执行过程：这一轮真做过的事，带真实耗时 -->
            <div v-if="m.steps?.length" class="sec">
              <button class="sec-head" :aria-expanded="secIsOpen(m.id, 'steps')" @click="toggleSec(m.id, 'steps')">
                <ChevronRight class="sec-caret" :class="{ open: secIsOpen(m.id, 'steps') }" :size="11" :stroke-width="2.2" />
                <ListChecks :size="12" :stroke-width="1.9" />
                <span>执行过程</span>
                <span class="sec-tail">{{ m.ms ? `${(m.ms / 1000).toFixed(1)}s` : '' }}</span>
              </button>
              <ol v-show="secIsOpen(m.id, 'steps')" class="sec-body steps">
                <li v-for="(s, i) in m.steps" :key="i" class="step" :data-status="s.status">
                  <span class="step-dot" />
                  <span class="step-label">{{ s.label }}</span>
                  <span v-if="s.detail" class="step-detail">{{ s.detail }}</span>
                  <span v-if="s.ms !== undefined" class="step-ms">{{ s.ms }}ms</span>
                </li>
              </ol>
            </div>

            <div
              v-if="m.content"
              class="md md-body body"
              v-html="rendered[m.id] ?? ''"
            />
            <div v-else-if="state.aiBusy && m.id === lastId" class="thinking-hint">
              <Loader2 class="spin" :size="12" :stroke-width="2" />
              <span>{{ state.aiStage }}</span>
            </div>

            <!-- 动作：一行图标，不写字 —— 窄栏里写字会把这一行撑爆 -->
            <div v-if="m.content" class="acts">
              <button class="act" title="复制" @click="copyMessage(m.id, m.content)">
                <Check v-if="copied === m.id" :size="13" :stroke-width="2.2" />
                <Copy v-else :size="13" :stroke-width="1.9" />
              </button>
              <button class="act" title="插入到当前笔记" @click="insertToNote(m.content)">
                <CornerDownLeft :size="13" :stroke-width="1.9" />
              </button>
              <button class="act" title="存成一篇新笔记" @click="saveAsNote(m.content)">
                <FilePlus2 :size="13" :stroke-width="1.9" />
              </button>
              <button
                v-if="m.id === lastId && !state.aiBusy"
                class="act"
                title="重新生成"
                @click="store.retryChat()"
              >
                <RefreshCw :size="13" :stroke-width="1.9" />
              </button>
            </div>
          </template>
        </template>
      </div>
    </div>

    <!-- ⑤ 快捷指令 -->
    <div class="chips">
      <button v-for="c in CHIPS" :key="c.label" class="chip" @click="useChip(c.text)">
        <component :is="c.icon" :size="11" :stroke-width="2" />
        <span>{{ c.label }}</span>
      </button>
    </div>

    <!-- ⑥ 输入区：正文在上，模型与发送在同一行的两端（照参考图） -->
    <div class="composer">
      <textarea
        ref="box"
        v-model="draft"
        class="input"
        rows="1"
        placeholder="输入消息，Enter 发送"
        title="Enter 发送，Shift+Enter 换行"
        spellcheck="false"
        @input="autoGrow"
        @keydown="onKey"
      />
      <div class="cm-row">
        <div class="m-wrap">
          <button class="ag-model" :class="{ on: modelMenu }" :title="`当前模型：${modelLabel}`" @click="toggleModel">
            <Cpu :size="12" :stroke-width="1.9" />
            <span class="ag-model-name">{{ modelLabel }}</span>
          </button>

          <div v-if="modelMenu" class="n-menu n-menu-inline m-menu">
            <div class="n-menu-head">
              <span>选择模型</span>
              <span class="n-menu-head-acts">
                <button class="ag-mini" :disabled="modelLoading" title="重新拉一遍模型列表" @click="loadModels(true)">
                  <Loader2 v-if="modelLoading" class="spin" :size="12" :stroke-width="2" />
                  <RefreshCw v-else :size="12" :stroke-width="2" />
                </button>
              </span>
            </div>
            <button
              v-for="m in modelOptions"
              :key="m"
              class="n-menu-item"
              :class="{ on: m === state.ai.model }"
              @click="pickModel(m)"
            >
              <span class="n-menu-name">{{ m }}</span>
              <Check v-if="m === state.ai.model" :size="12" :stroke-width="2.2" />
            </button>
            <p v-if="serverModels.length === 0" class="n-menu-hint">
              {{ modelLoading ? '正在读取接口…' : '没读到接口的模型列表，先列出预设' }}
            </p>
            <span class="n-menu-sep" />
            <button class="n-menu-item" @click="openAiSettings">
              <Settings :size="12" :stroke-width="1.9" />
              <span class="n-menu-name">模型设置…</span>
            </button>
          </div>
        </div>

        <button class="send" :class="{ off: !canSend }" :disabled="!canSend" title="发送 (Enter)" @click="send">
          <ArrowUp :size="15" :stroke-width="2.2" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ag {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--n-bg);
}

/* ══ ① AI 助手卡片 ══ */
.ag-card {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 8px 8px 0;
  padding: 9px 9px 9px 10px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-surface);
}

.ag-avatar {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.ag-avatar svg {
  fill: none;
  stroke: currentColor;
}

.ag-id {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ag-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-fg);
}

.ag-sub {
  font-size: 10.5px;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ag-x {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
}

.ag-x svg {
  fill: none;
  stroke: currentColor;
}

.ag-x:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

/* ══ ② 会话行 ══
   左边那一格是会话选择器（会话名就是第一条指令，所以看着像「这次在聊什么」），
   右边两枚：新建会话、删掉当前会话。 */
.ag-sess {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  margin: 6px 8px 0;
  padding: 0 4px 0 4px;
  height: 32px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-surface);
}

.ss-wrap {
  flex: 1;
  min-width: 0;
}

.ag-sess-pick {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 6px;
  border-radius: var(--n-r-md);
  font-size: 11.5px;
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.ag-sess-pick svg {
  flex: none;
  fill: none;
  stroke: currentColor;
}

.ag-sess-pick:hover,
.ag-sess-pick.on {
  background: var(--n-raised);
  color: var(--n-fg);
}

.ag-sess-pick.dim .ag-sess-name {
  color: var(--n-fg-faint);
}

.ag-sess-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

/* ══ ③ 上下文开关 + 笔记选择 ══ */
.ag-note {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 8px 0;
}

.ag-note-label {
  flex: none;
  font-size: 11.5px;
  color: var(--n-fg-dim);
}

.ag-note-label.on {
  color: var(--n-accent);
}

.ag-switch {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--n-line);
  background: color-mix(in oklab, var(--n-fg-faint) 26%, transparent);
  transition: background var(--n-dur) var(--n-ease), border-color var(--n-dur) var(--n-ease);
}

.ag-switch.on {
  background: var(--n-accent);
  border-color: var(--n-accent);
}

.ag-knob {
  position: absolute;
  top: 50%;
  left: 2px;
  width: 14px;
  height: 14px;
  margin-top: -7px;
  border-radius: 50%;
  background: var(--n-raised);
  box-shadow: 0 1px 2px color-mix(in oklab, #000 26%, transparent);
  transition: left var(--n-dur) var(--n-ease);
}

.ag-switch.on .ag-knob {
  left: 16px;
}

.np-wrap,
.m-wrap,
.ss-wrap {
  position: relative;
  min-width: 0;
}

.np-wrap {
  flex: 1;
}

.ag-pick {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--n-line);
  border-radius: 999px;
  background: var(--n-surface);
  font-size: 11.5px;
  color: var(--n-fg-dim);
  transition: border-color var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.ag-pick:hover {
  border-color: var(--n-line-strong);
  color: var(--n-fg);
}

.ag-pick.on {
  border-color: var(--n-accent);
  color: var(--n-accent);
}

.ag-pick-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

.np-menu {
  left: 0;
  width: 100%;
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
}

/* 卡片收起来之后的那条细边 */
.ag-stub {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 8px 8px 0;
  padding: 5px 8px;
  border-radius: var(--n-r-sm);
  font-size: 11px;
  color: var(--n-fg-faint);
}

.ag-stub svg {
  fill: none;
  stroke: currentColor;
}

.ag-stub:hover {
  background: var(--n-raised);
  color: var(--n-fg-dim);
}

/* ══ ④ 消息流 ══ */
.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 10px 4px;
}

.ag-empty {
  padding: 18px 4px 10px;
}

.ag-empty-title {
  margin: 0 0 5px;
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--n-fg);
}

.ag-empty-sub {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--n-fg-dim);
}

.link {
  color: var(--n-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.row {
  display: flex;
  flex-direction: column;
  /* 靠左是默认：助手那一段贴左边，我说的靠右（见 .row.user） */
  align-items: flex-start;
  gap: 5px;
  margin-bottom: 14px;
}

/* 我靠右：整条右对齐，只有气泡有底色 */
.row.user {
  align-items: flex-end;
}

.who {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--n-fg-faint);
}

.who.asst {
  color: var(--n-fg-mid);
}

.row.user .bubble {
  max-width: 88%;
  padding: 9px 11px;
  border-radius: 11px;
  border: 1px solid var(--n-line);
  background: var(--n-raised);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--n-fg);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 助手正文不走气泡：窄栏里一层边框少一层压迫 */
.body {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--n-fg);
}

/* ══ 思考过程 / 执行过程 ══ */
.sec {
  border-radius: var(--n-r-md);
  background: color-mix(in oklab, var(--n-surface) 76%, transparent);
}

.sec-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--n-fg-dim);
  border-radius: var(--n-r-md);
}

.sec-head:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.sec-head svg {
  flex: none;
  fill: none;
  stroke: currentColor;
}

.sec-caret {
  transition: transform var(--n-dur) var(--n-ease);
}

.sec-caret.open {
  transform: rotate(90deg);
}

.sec-tail {
  margin-left: auto;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
}

.sec-body {
  margin: 0;
  padding: 2px 9px 8px 24px;
  font-size: 11px;
  line-height: 1.7;
}

.think {
  color: var(--n-fg-dim);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
}

/* 思考时的光标：让「正在往外流」这件事看得见 */
.caret {
  display: inline-block;
  width: 5px;
  height: 11px;
  margin-left: 2px;
  vertical-align: -1px;
  background: var(--n-accent);
  animation: ag-blink 1s steps(2, start) infinite;
}

@keyframes ag-blink {
  50% { opacity: 0; }
}

.steps {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.step-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--n-fg-faint);
  transform: translateY(-1px);
}

.step[data-status='ok'] .step-dot {
  background: var(--n-ok);
}

.step[data-status='fail'] .step-dot {
  background: var(--n-danger);
}

.step[data-status='run'] .step-dot {
  background: var(--n-accent);
  animation: ag-pulse 1.1s ease-in-out infinite;
}

@keyframes ag-pulse {
  50% { opacity: 0.28; }
}

.step-label {
  flex: none;
  color: var(--n-fg-mid);
}

.step-detail {
  flex: 1;
  min-width: 0;
  color: var(--n-fg-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-ms {
  flex: none;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
}

.thinking-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 11px;
  color: var(--n-fg-faint);
}

.spin {
  animation: ag-spin 900ms linear infinite;
}

@keyframes ag-spin {
  to { transform: rotate(360deg); }
}

/* 出错 */
.err {
  padding: 8px 10px;
  border-radius: var(--n-r-md);
  border: 1px solid color-mix(in oklab, #d0453b 34%, var(--n-line));
  background: color-mix(in oklab, #d0453b 7%, var(--n-surface));
  font-size: 11.5px;
}

.err-text {
  margin: 0 0 7px;
  color: #b3342b;
}

.err-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: var(--n-r-sm);
  border: 1px solid color-mix(in oklab, #d0453b 34%, var(--n-line));
  background: var(--n-bg);
  font-size: 11px;
  color: #b3342b;
}

.err-btn svg {
  fill: none;
  stroke: currentColor;
}

/* 动作行：一行图标，悬停才明显 */
.acts {
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0.55;
  transition: opacity var(--n-dur) var(--n-ease);
}

.row:hover .acts,
.acts:focus-within {
  opacity: 1;
}

.act {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.act svg {
  fill: none;
  stroke: currentColor;
}

.act:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

/* ══ ⑤ 快捷指令 ══ */
.chips {
  flex: none;
  display: flex;
  gap: 5px;
  padding: 4px 10px 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.chips::-webkit-scrollbar {
  display: none;
}

.chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--n-line);
  border-radius: 999px;
  background: var(--n-surface);
  font-size: 11px;
  color: var(--n-fg-dim);
  white-space: nowrap;
  transition: border-color var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.chip svg {
  fill: none;
  stroke: currentColor;
  color: var(--n-accent);
}

.chip:hover {
  border-color: var(--n-accent);
  color: var(--n-fg);
}

/* ══ ⑥ 输入区 ══
   一个带边框的盒子：上面写话，下面一行左边是当前模型、右边是发送。
   参考图就是这样 —— 模型不必另占一行，跟发送同在一行的两端更紧凑。 */
.composer {
  flex: none;
  margin: 8px 10px 10px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-surface);
  transition: border-color var(--n-dur) var(--n-ease);
}

.composer:focus-within {
  border-color: var(--n-accent);
}

.input {
  display: block;
  width: 100%;
  min-height: 54px;
  max-height: 180px;
  padding: 9px 11px 2px;
  border: none;
  border-radius: var(--n-r-lg);
  background: none;
  color: var(--n-fg);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.7;
  resize: none;
  outline: none;
}

.input::placeholder {
  color: var(--n-fg-faint);
}

.cm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 7px 7px;
}

.send {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-md);
  background: var(--n-accent);
  color: var(--n-on-accent);
  transition: opacity var(--n-dur) var(--n-ease);
}

.send svg {
  fill: none;
  stroke: currentColor;
}

.send.off {
  opacity: 0.34;
}

.ag-model {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  height: 22px;
  padding: 0 6px;
  border-radius: var(--n-r-sm);
  font-size: 10.5px;
  color: var(--n-fg-faint);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.ag-model svg {
  flex: none;
  fill: none;
  stroke: currentColor;
}

.ag-model:hover,
.ag-model.on {
  background: var(--n-raised);
  color: var(--n-fg-dim);
}

.ag-model-name {
  min-width: 0;
  font-family: var(--n-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ag-mini {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.ag-mini svg {
  fill: none;
  stroke: currentColor;
}

.ag-mini:hover:not(:disabled),
.ag-mini.on {
  background: var(--n-raised);
  color: var(--n-accent);
}

.ag-mini.danger:hover:not(:disabled) {
  color: var(--n-danger);
}

.ag-mini:disabled {
  opacity: 0.4;
}

/* 弹出的菜单：往上开，别被底边裁掉 */
/* 模型菜单在输入区里（贴着底部），所以往上开，不然会被底边裁掉 */
.m-menu {
  bottom: calc(100% + 6px);
  top: auto;
  left: 0;
  width: 236px;
  max-height: 320px;
  overflow-y: auto;
}

/* 会话菜单在面板顶上，往下开 */
.ss-menu {
  top: calc(100% + 6px);
  left: 0;
  width: 100%;
  min-width: 236px;
  max-height: 320px;
  overflow-y: auto;
}

.ss-menu .n-menu-item .n-menu-name {
  font-family: inherit;
  font-size: 12px;
}
</style>
