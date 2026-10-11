<script setup lang="ts">
/**
 * AI 编写：主区里的对话页。
 *
 * 为什么不做成侧边的一个小面板：写东西时最需要的是「能看着整段回答」，
 * 一条窄侧栏塞不下代码块和长段落。所以它是一个正式的页面（和参考项目一样
 * 从左侧导航进入），只是不抢编辑区——切回笔记就是原样。
 *
 * 渲染复用预览区那条 Markdown 管线，所以模型吐出来的代码块、
 * 表格、公式长得和笔记预览一模一样。
 */
import { computed, nextTick, ref, watch } from 'vue'
import {
  ArrowUp,
  Check,
  Copy,
  CornerDownLeft,
  Eraser,
  FileText,
  Paperclip,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
} from 'lucide-vue-next'
import { store } from '@/store'
import { markdownToHtml } from '@/editor/markdown'
import { renderMathInHtml, renderMermaidInHtml } from '@/editor/preview-rich'

const { state } = store

const scroller = ref<HTMLDivElement | null>(null)
const box = ref<HTMLTextAreaElement | null>(null)
const draft = ref('')
/** 是否把当前笔记作为上下文一起发过去 */
const withNote = ref(true)
/** 已渲染的消息 HTML：id → html */
const rendered = ref<Record<number, string>>({})
const copied = ref(0)

const modelLabel = computed(() => state.ai.model || '未配置模型')
const canSend = computed(() => draft.value.trim().length > 0 && !state.aiBusy)
/** 当前会话里最后一条助手消息（它才配拥有「重新生成」） */
const lastAssistantId = computed(() => {
  for (let i = state.chat.length - 1; i >= 0; i -= 1) {
    if (state.chat[i].role === 'assistant') return state.chat[i].id
  }
  return 0
})

/** 快速开始：四个最常见的姿势，点一下填进输入框而不是直接发送——留一次反悔的机会 */
const QUICK = [
  { title: '总结这篇笔记', hint: '抓出结论与待办', text: '把当前笔记总结成要点列表。' },
  { title: '写个开头', hint: '给主题起头', text: '围绕这个主题写一段开头，两三句就够：' },
  { title: '润色这段', hint: '改病句、顺表达', text: '把下面这段润色一下，保留原意：\n' },
  { title: '列出大纲', hint: '先搭骨架', text: '给这个主题列一份三级大纲：' },
]

/* ── 渲染助手消息 ── */
async function renderMessage(id: number, content: string) {
  try {
    const { html } = await markdownToHtml(content)
    rendered.value = { ...rendered.value, [id]: html }
  } catch {
    rendered.value = { ...rendered.value, [id]: '' }
  }
}

/** 新出现的助手消息（含刚重生成的那条）都要渲染一遍 */
watch(
  () => state.chat.length,
  async () => {
    const msg = state.chat[state.chat.length - 1]
    if (msg && msg.role === 'assistant' && !msg.error && rendered.value[msg.id] === undefined) {
      await renderMessage(msg.id, msg.content)
    }
    await nextTick()
    scrollToEnd()
    const el = scroller.value
    if (el) {
      void renderMathInHtml(el)
      void renderMermaidInHtml(el)
    }
  },
)

function scrollToEnd() {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
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
  await store.sendChat(text, { withNote: withNote.value })
}

function onKey(e: KeyboardEvent) {
  // Enter 发送、Shift+Enter 换行——和所有聊天工具一致
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

function useQuick(text: string) {
  draft.value = text
  nextTick(() => {
    box.value?.focus()
    autoGrow()
  })
}

/* ── 消息上的动作 ── */
function insertToNote(content: string) {
  const v = (window as unknown as { __notaView?: { state: unknown } }).__notaView
  if (!v) {
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

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

function openAiSettings() {
  window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'ai' }))
}
</script>

<template>
  <div class="chat">
    <!-- 头部：和编辑区顶栏同高同语言，切换页面不会有跳感 -->
    <header class="head">
      <span class="head-ico"><Sparkles :size="15" :stroke-width="1.9" /></span>
      <span class="head-title">AI 编写</span>
      <span class="model" :title="state.ai.baseUrl">{{ modelLabel }}</span>
      <span class="head-right">
        <button
          v-if="state.chat.length"
          class="hbtn"
          title="清空对话"
          @click="store.clearChat()"
        >
          <Eraser :size="14" :stroke-width="1.9" />
        </button>
        <button class="hbtn" title="AI 设置" @click="openAiSettings">
          <Settings :size="14" :stroke-width="1.9" />
        </button>
      </span>
    </header>

    <div ref="scroller" class="stream">
      <!-- 空态：给四个可以直接用的起手式，而不是一句「开始对话吧」 -->
      <div v-if="state.chat.length === 0" class="hero">
        <span class="hero-ico"><Sparkles :size="22" :stroke-width="1.7" /></span>
        <h2 class="hero-title">让 AI 帮你写</h2>
        <p class="hero-sub">
          对话走本机配置的模型（{{ modelLabel }}），也可以接云端 —— 在
          <button class="link" @click="openAiSettings">AI 编写设置</button> 里改。
        </p>
        <div class="quick">
          <button
            v-for="q in QUICK"
            :key="q.title"
            class="quick-card"
            @click="useQuick(q.text)"
          >
            <span class="quick-title">{{ q.title }}</span>
            <span class="quick-hint">{{ q.hint }}</span>
          </button>
        </div>
      </div>

      <!-- 消息 -->
      <div v-for="m in state.chat" :key="m.id" class="row" :class="m.role">
        <span class="avatar">
          <FileText v-if="m.role === 'user'" :size="13" :stroke-width="2" />
          <Sparkles v-else :size="13" :stroke-width="2" />
        </span>
        <div class="bubble-wrap">
          <div class="who">{{ m.role === 'user' ? '我' : 'AI' }}</div>

          <div v-if="m.error" class="bubble error">
            <p class="err-text">{{ m.error }}</p>
            <button class="err-btn" @click="store.retryChat()">
              <RefreshCw :size="12" :stroke-width="2" /><span>重试</span>
            </button>
          </div>

          <div v-else-if="m.role === 'user'" class="bubble">{{ m.content }}</div>

          <div
            v-else
            class="bubble md md-body"
            v-html="rendered[m.id] ?? '<p>…</p>'"
          />

          <div v-if="!m.error" class="acts">
            <button class="act" title="复制" @click="copyMessage(m.id, m.content)">
              <Check v-if="copied === m.id" :size="12" :stroke-width="2.2" />
              <Copy v-else :size="12" :stroke-width="1.9" />
              <span>{{ copied === m.id ? '已复制' : '复制' }}</span>
            </button>
            <button class="act" title="插入到当前笔记" @click="insertToNote(m.content)">
              <CornerDownLeft :size="12" :stroke-width="1.9" /><span>插入笔记</span>
            </button>
            <button
              v-if="m.id === lastAssistantId && !state.aiBusy"
              class="act"
              title="重新生成"
              @click="store.retryChat()"
            >
              <RefreshCw :size="12" :stroke-width="1.9" /><span>重新生成</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 等待中 -->
      <div v-if="state.aiBusy" class="row assistant">
        <span class="avatar"><Sparkles :size="13" :stroke-width="2" /></span>
        <div class="bubble-wrap">
          <div class="who">AI</div>
          <div class="bubble typing"><span /><span /><span /></div>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="composer">
      <div class="input-box">
        <textarea
          ref="box"
          v-model="draft"
          class="input"
          rows="1"
          placeholder="问点什么，或者贴一段文字让我改…（Enter 发送，Shift+Enter 换行）"
          spellcheck="false"
          @input="autoGrow"
          @keydown="onKey"
        />
        <button
          class="send"
          :class="{ off: !canSend }"
          :disabled="!canSend"
          title="发送 (Enter)"
          @click="send"
        >
          <ArrowUp :size="15" :stroke-width="2.2" />
        </button>
      </div>
      <div class="composer-foot">
        <button
          class="ctx"
          :class="{ on: withNote }"
          :aria-pressed="withNote"
          @click="withNote = !withNote"
        >
          <Paperclip :size="11" :stroke-width="2" />
          <span>带上当前笔记</span>
        </button>
        <span v-if="state.aiBusy" class="busy">
          <Square :size="9" :stroke-width="3" />生成中…
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--n-bg);
}

/* ── 头部 ── */
.head {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--n-line);
  background: var(--n-surface);
}

.head-ico {
  display: inline-flex;
  color: var(--n-accent);
}

.head-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--n-fg);
}

.model {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--n-line);
  background: var(--n-bg);
  font-family: var(--n-font-mono);
  font-size: 10.5px;
  color: var(--n-fg-dim);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.hbtn {
  width: 26px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.hbtn svg {
  fill: none;
  stroke: currentColor;
}

.hbtn:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

/* ── 消息流 ── */
.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* 空态 */
.hero {
  max-width: 640px;
  margin: 0 auto;
  padding: clamp(28px, 9vh, 80px) 24px 24px;
  text-align: center;
}

.hero-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.hero-title {
  margin: 14px 0 6px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--n-fg);
}

.hero-sub {
  margin: 0 auto;
  max-width: 420px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--n-fg-dim);
}

.link {
  color: var(--n-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.quick {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  margin-top: 22px;
}

.quick-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: flex-start;
  padding: 11px 13px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-surface);
  text-align: left;
  transition: border-color var(--n-dur) var(--n-ease), background var(--n-dur) var(--n-ease);
}

.quick-card:hover {
  border-color: var(--n-accent);
  background: var(--n-raised);
}

.quick-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-fg);
}

.quick-hint {
  font-size: 11px;
  color: var(--n-fg-faint);
}

/* 一轮对话 */
.row {
  display: flex;
  gap: 10px;
  max-width: 760px;
  margin: 0 auto;
  padding: 14px 24px;
}

.row.user {
  padding-top: 18px;
}

.avatar {
  flex: none;
  width: 24px;
  height: 24px;
  margin-top: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--n-surface);
  color: var(--n-fg-dim);
}

.row.assistant .avatar {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.bubble-wrap {
  min-width: 0;
  flex: 1;
}

.who {
  font-size: 11px;
  font-weight: 600;
  color: var(--n-fg-faint);
  margin-bottom: 4px;
}

.bubble {
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--n-fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 助手回答是 Markdown，交给 .md 里的排版规则 */
.bubble.md {
  white-space: normal;
  user-select: text;
}

.bubble.error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in oklab, var(--n-danger) 34%, var(--n-line));
  border-radius: var(--n-r-md);
  background: var(--n-danger-soft);
}

.err-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--n-danger);
  white-space: pre-wrap;
}

.err-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid color-mix(in oklab, var(--n-danger) 40%, var(--n-line));
  border-radius: var(--n-r-sm);
  font-size: 11.5px;
  color: var(--n-danger);
}

.err-btn svg {
  fill: none;
  stroke: currentColor;
}

.err-btn:hover {
  background: color-mix(in oklab, var(--n-danger) 12%, transparent);
}

/* 每条消息的悬浮动作 */
.acts {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity var(--n-dur) var(--n-ease);
}

.row:hover .acts,
.acts:focus-within {
  opacity: 1;
}

.act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border-radius: var(--n-r-sm);
  font-size: 11px;
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.act svg {
  fill: none;
  stroke: currentColor;
}

.act:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}

/* 等待中的三点 */
.typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
}

.typing span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--n-fg-faint);
  animation: chat-dot 1.1s var(--n-ease) infinite;
}

.typing span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes chat-dot {
  0%,
  60%,
  100% {
    opacity: 0.28;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

/* ── 输入区 ── */
.composer {
  flex: none;
  padding: 0 24px 14px;
}

.input-box {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  max-width: 760px;
  margin: 0 auto;
  padding: 8px 8px 8px 12px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-lg);
  background: var(--n-raised);
  transition: border-color var(--n-dur) var(--n-ease), box-shadow var(--n-dur) var(--n-ease);
}

.input-box:focus-within {
  border-color: var(--n-accent);
  box-shadow: 0 0 0 3px var(--n-accent-soft);
}

.input {
  flex: 1;
  min-width: 0;
  max-height: 180px;
  padding: 4px 0;
  border: none;
  background: none;
  outline: none;
  resize: none;
  font-family: var(--n-font-ui);
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--n-fg);
}

.input::placeholder {
  color: var(--n-fg-faint);
}

.send {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--n-accent);
  color: var(--n-on-accent);
  transition: opacity var(--n-dur) var(--n-ease), transform var(--n-dur) var(--n-ease);
}

.send svg {
  fill: none;
  stroke: currentColor;
}

.send:hover:not(.off) {
  transform: translateY(-1px);
}

.send.off {
  opacity: 0.4;
  cursor: default;
}

.composer-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 760px;
  margin: 8px auto 0;
  padding-left: 2px;
}

.ctx {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border: 1px solid var(--n-line);
  border-radius: 999px;
  font-size: 11px;
  color: var(--n-fg-faint);
  transition: color var(--n-dur) var(--n-ease), border-color var(--n-dur) var(--n-ease),
    background var(--n-dur) var(--n-ease);
}

.ctx svg {
  fill: none;
  stroke: currentColor;
}

.ctx.on {
  border-color: color-mix(in oklab, var(--n-accent) 42%, var(--n-line));
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.busy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--n-accent);
}
</style>
