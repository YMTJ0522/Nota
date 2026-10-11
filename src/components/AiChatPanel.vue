<script setup lang="ts">
/**
 * AI 编写：主区里的对话页。
 *
 * 布局照常规 agent 的样子来：
 * - 左侧一栏是会话列表，能新建 / 切换 / 重命名 / 删除，刷新后还在；
 * - 右侧是消息流，AI 靠左、我靠右——谁是说话的一眼分得清。
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
  MessageSquare,
  PanelLeft,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
  Trash2,
  User,
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
/** 会话栏的显隐。窄窗口下可以收起来，把宽度让给正文 */
const railOpen = ref(true)
/** 已渲染的消息 HTML：id → html */
const rendered = ref<Record<number, string>>({})
/** 这份 HTML 属于哪个会话。切会话时整段重渲染 */
const renderedSid = ref(0)
const copied = ref(0)
/** 正在改名的会话 id */
const editingId = ref(0)
const editingText = ref('')

const modelLabel = computed(() => state.ai.model || '未配置模型')
const canSend = computed(() => draft.value.trim().length > 0 && !state.aiBusy)
/** 当前会话里最后一条助手消息（它才配拥有「重新生成」） */
const lastAssistantId = computed(() => {
  for (let i = state.chat.length - 1; i >= 0; i -= 1) {
    if (state.chat[i].role === 'assistant') return state.chat[i].id
  }
  return 0
})

/** 会话列表按最近发言倒序，跟大多数聊天工具一致 */
const sessions = computed(() =>
  [...state.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
)

/** 列表里只显示「几点」或「几月几号」，完整时间交给 title */
function when(ts: number) {
  const d = new Date(ts || Date.now())
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function fullTime(ts: number) {
  const d = new Date(ts || Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(
    2,
    '0',
  )}`
}

/** 切会话：换完把视图滚到底，不然会停在上一条对话的中间 */
async function pickSession(id: number) {
  if (id === state.activeSessionId) return
  store.switchSession(id)
  await nextTick()
  scrollToEnd()
}

function removeSession(id: number, e: MouseEvent) {
  e.stopPropagation()
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return
  if (s.messages.length && !window.confirm(`删除会话「${s.title}」？`)) return
  store.deleteSession(id)
}

async function createSession() {
  store.newChat()
  await nextTick()
  box.value?.focus()
}

/* ── 重命名 ── */
function startRename(id: number, title: string) {
  editingId.value = id
  editingText.value = title
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.sess-edit')
    el?.focus()
    el?.select()
  })
}

function commitRename() {
  if (!editingId.value) return
  store.renameSession(editingId.value, editingText.value)
  editingId.value = 0
}

function cancelRename() {
  editingId.value = 0
}

/** 快速开始：四个最常见的姿势，点一下填进输入框而不是直接发送——留一次反悔的机会 */
const QUICK: { title: string; hint: string; text: string }[] = [
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
  () => [state.chat.length, state.activeSessionId, state.chat[state.chat.length - 1]?.content],
  async () => {
    if (renderedSid.value !== state.activeSessionId) {
      // 切会话时整段重渲染：换过去是别的会话，缓存里没有它的 HTML
      renderedSid.value = state.activeSessionId
      rendered.value = {}
      for (const m of state.chat) {
        if (m.role === 'assistant' && !m.error) await renderMessage(m.id, m.content)
      }
    } else {
      const msg = state.chat[state.chat.length - 1]
      if (msg && msg.role === 'assistant' && !msg.error && rendered.value[msg.id] === undefined) {
        await renderMessage(msg.id, msg.content)
      }
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

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

function openAiSettings() {
  window.dispatchEvent(new CustomEvent('nota:settings', { detail: 'ai' }))
}
</script>

<template>
  <div class="chat">
    <!-- 会话栏：默认展开，窄窗口可以收起让正文宽一点 -->
    <aside v-if="railOpen" class="rail">
      <div class="rail-head">
        <span class="rail-title">会话</span>
        <button class="rail-add" title="新建会话" @click="createSession">
          <Plus :size="14" :stroke-width="2.2" />
        </button>
      </div>

      <div class="rail-list">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="sess"
          :class="{ on: s.id === state.activeSessionId }"
          @click="pickSession(s.id)"
        >
          <span class="sess-ico"><MessageSquare :size="13" :stroke-width="1.9" /></span>

          <span v-if="editingId === s.id" class="sess-body">
            <input
              v-model="editingText"
              class="sess-edit"
              spellcheck="false"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
          </span>

          <span v-else class="sess-body">
            <span class="sess-name">{{ s.title }}</span>
            <span class="sess-time" :title="fullTime(s.updatedAt)">{{ when(s.updatedAt) }}</span>
          </span>

          <span class="sess-acts">
            <button
              class="sess-btn"
              title="重命名"
              @click.stop="startRename(s.id, s.title)"
            >
              <Pencil :size="12" :stroke-width="2" />
            </button>
            <button class="sess-btn danger" title="删除会话" @click.stop="removeSession(s.id, $event)">
              <Trash2 :size="12" :stroke-width="2" />
            </button>
          </span>
        </div>
      </div>
    </aside>

    <div class="main">
      <!-- 头部：和编辑区顶栏同高同语言，切换页面不会有跳感 -->
      <header class="head">
        <button
          class="hbtn"
          :class="{ on: railOpen }"
          title="会话列表"
          @click="railOpen = !railOpen"
        >
          <PanelLeft :size="14" :stroke-width="1.9" />
        </button>
        <span class="head-ico"><Sparkles :size="15" :stroke-width="1.9" /></span>
        <span class="head-title">AI 编写</span>
        <span class="model" :title="state.ai.baseUrl">{{ modelLabel }}</span>
        <span class="head-right">
          <button
            v-if="state.chat.length"
            class="hbtn"
            title="清空当前会话"
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

        <!-- 消息：AI 靠左，我靠右 -->
        <div v-for="m in state.chat" :key="m.id" class="row" :class="m.role">
          <span class="avatar">
            <User v-if="m.role === 'user'" :size="13" :stroke-width="2" />
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
                v-if="m.role === 'assistant' && m.id === lastAssistantId && !state.aiBusy"
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
  </div>
</template>

<style scoped>
.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  background: var(--n-bg);
}

/* ── 会话栏 ── */
.rail {
  flex: none;
  width: 208px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--n-line);
  background: var(--n-surface);
}

.rail-head {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--n-line);
}

.rail-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--n-fg-faint);
}

.rail-add {
  margin-left: auto;
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.rail-add:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

.rail-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.sess {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 6px 0 9px;
  border-radius: var(--n-r-md);
  font-size: 12px;
  color: var(--n-fg-mid);
  cursor: pointer;
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.sess:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.sess.on {
  background: color-mix(in oklab, var(--n-accent-soft) 76%, transparent);
  color: var(--n-fg);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--n-accent) 22%, transparent);
}

.sess-ico {
  flex: none;
  display: inline-flex;
  color: var(--n-fg-faint);
}

.sess.on .sess-ico {
  color: var(--n-accent);
}

.sess-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sess-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sess-time {
  font-size: 10px;
  color: var(--n-fg-faint);
  font-variant-numeric: tabular-nums;
}

.sess-edit {
  width: 100%;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--n-accent);
  border-radius: var(--n-r-sm);
  background: var(--n-bg);
  color: var(--n-fg);
  font-size: 12px;
  outline: none;
}

/* 操作按钮平时藏着，hover 或选中才出来——列表里不该一直飘着两个图标 */
.sess-acts {
  flex: none;
  display: none;
  align-items: center;
  gap: 1px;
}

.sess:hover .sess-acts,
.sess.on .sess-acts {
  display: inline-flex;
}

.sess-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.sess-btn:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.sess-btn.danger:hover {
  color: #d0453b;
}

/* ── 正文 ── */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
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
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.hbtn:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

.hbtn.on {
  color: var(--n-accent);
}

.hbtn svg,
.rail-add svg {
  fill: none;
  stroke: currentColor;
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

/* 我靠右：整行翻转，头像落到右侧，气泡右对齐 */
.row.user {
  flex-direction: row-reverse;
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

.row.user .avatar {
  background: var(--n-raised);
  color: var(--n-fg-mid);
}

.bubble-wrap {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row.user .bubble-wrap {
  align-items: flex-end;
}

.who {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--n-fg-faint);
}

.bubble {
  max-width: 100%;
  padding: 9px 13px;
  border-radius: var(--n-r-lg);
  border: 1px solid var(--n-line);
  background: var(--n-surface);
  font-size: 13px;
  line-height: 1.75;
  color: var(--n-fg);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 我的气泡用强调色淡底，和 AI 的灰底分得开 */
.row.user .bubble {
  background: color-mix(in oklab, var(--n-accent-soft) 58%, var(--n-surface));
  border-color: color-mix(in oklab, var(--n-accent) 18%, var(--n-line));
}

/* 助手回答走完整排版，所以取消气泡自己的预格式化 */
.bubble.md {
  padding: 4px 2px;
  border: 0;
  background: transparent;
  white-space: normal;
}

.bubble.error {
  border-color: color-mix(in oklab, #d0453b 34%, var(--n-line));
  background: color-mix(in oklab, #d0453b 7%, var(--n-surface));
}

.err-text {
  margin: 0 0 8px;
  color: #b3342b;
}

.err-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border-radius: var(--n-r-sm);
  border: 1px solid color-mix(in oklab, #d0453b 34%, var(--n-line));
  background: var(--n-bg);
  font-size: 11px;
  color: #b3342b;
}

.err-btn:hover {
  background: color-mix(in oklab, #d0453b 10%, var(--n-bg));
}

.acts {
  display: flex;
  align-items: center;
  gap: 2px;
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
  font-size: 10.5px;
  color: var(--n-fg-faint);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.act:hover {
  background: var(--n-raised);
  color: var(--n-accent);
}

/* 打字中 */
.bubble.typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 12px 14px;
}

.bubble.typing span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--n-fg-faint);
  animation: blink 1.2s infinite ease-in-out;
}

.bubble.typing span:nth-child(2) {
  animation-delay: 0.18s;
}

.bubble.typing span:nth-child(3) {
  animation-delay: 0.36s;
}

@keyframes blink {
  0%,
  70%,
  100% {
    opacity: 0.22;
  }
  35% {
    opacity: 1;
  }
}

/* ── 输入区 ── */
.composer {
  flex: none;
  padding: 10px 24px 14px;
}

.input-box {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 8px 8px 14px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-surface);
  transition: border-color var(--n-dur) var(--n-ease);
}

.input-box:focus-within {
  border-color: var(--n-accent);
}

.input {
  flex: 1;
  min-width: 0;
  max-height: 180px;
  padding: 5px 0;
  border: 0;
  background: transparent;
  color: var(--n-fg);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  resize: none;
  outline: none;
}

.send {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-md);
  background: var(--n-accent);
  color: #fff;
  transition: opacity var(--n-dur) var(--n-ease);
}

.send.off {
  opacity: 0.34;
}

.send svg {
  fill: none;
  stroke: currentColor;
}

.composer-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.ctx {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--n-line);
  background: var(--n-surface);
  font-size: 10.5px;
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.ctx.on {
  border-color: color-mix(in oklab, var(--n-accent) 34%, var(--n-line));
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.busy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--n-fg-faint);
}

.busy svg {
  fill: currentColor;
  stroke: none;
}
</style>
