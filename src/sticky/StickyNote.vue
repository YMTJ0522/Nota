<script setup lang="ts">
/**
 * 一张便签。
 *
 * 设计上只有一个决心：**打开就能打字**。所以这里没有 Markdown 高亮、
 * 没有工具栏、没有标题栏输入框 —— 那些东西每一样都在抢「按下快捷键到
 * 第一个字出现在屏幕上」的那段时间。要排版，点「存为笔记」进主程序去弄。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, NotebookPen, Palette, Pin, PinOff, X } from 'lucide-vue-next'
import { PAPERS, paperOf } from './colors'

const id = new URLSearchParams(location.search).get('id') ?? ''

const text = ref('')
const pinned = ref(true)
const colorKey = ref('amber')
const savedTo = ref('')
const ready = ref(false)
const picker = ref(false)
const hint = ref('')

const ta = ref<HTMLTextAreaElement | null>(null)
const paper = computed(() => paperOf(colorKey.value))

const style = computed(() => ({
  background: paper.value.bg,
  color: paper.value.fg,
  '--p-dim': paper.value.dim,
  '--p-hover': paper.value.hover,
}))

/* ── 自动保存 ──
   280ms 是权衡的结果：再短，一句话打完要写十几次盘；再长，
   用户敲完立刻按 Esc 就有窗口丢字的可能（关闭时会先 flush，
   但进程被强杀那一下没机会）。 */
let timer = 0

function scheduleSave() {
  if (timer) clearTimeout(timer)
  timer = window.setTimeout(() => void flush(), 280)
}

async function flush() {
  if (timer) {
    clearTimeout(timer)
    timer = 0
  }
  if (!ready.value) return
  await window.sticky.write(id, text.value)
}

function onInput() {
  savedTo.value = ''
  scheduleSave()
}

/* ── 关闭 ──
   先把最后这一段写下去再关。直接发 close 的话，主进程收尾用的是
   内存里上一次上报的正文，正在打的这半句就丢了。 */
async function close() {
  await flush()
  await window.sticky.close(id)
}

/* ── 存为笔记 ──
   存完不关窗口：用户常常是「先记下来，回头再补两句」，关掉反而要重开。
   按钮也不置灰 —— 改完想再存一版是合理需求，存储层会自动加 -2。 */
async function save() {
  await flush()
  const r = await window.sticky.saveToVault(id)
  if (r.ok && r.rel) {
    savedTo.value = r.rel
    hint.value = `已存入 ${r.rel}`
    window.setTimeout(() => (hint.value = ''), 2600)
  } else {
    hint.value = r.error ?? '没存进去'
    window.setTimeout(() => (hint.value = ''), 3000)
  }
}

async function togglePin() {
  pinned.value = !pinned.value
  await window.sticky.pin(id, pinned.value)
}

async function pickColor(key: string) {
  colorKey.value = key
  picker.value = false
  await window.sticky.color(id, key)
  ta.value?.focus()
}

/**
 * Esc 关掉。
 * isComposing 必须挡：中文输入法里按 Esc 是「取消这串候选词」，
 * 不挡的话用户想撤掉拼音，整张便签没了。
 */
async function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Escape') {
    e.preventDefault()
    if (picker.value) {
      picker.value = false
      return
    }
    await close()
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    await save()
  }
}

onMounted(async () => {
  const data = await window.sticky.load(id)
  if (!data) {
    hint.value = '这张便签已经不在了'
    return
  }
  text.value = data.text
  pinned.value = data.pinned
  colorKey.value = data.color
  savedTo.value = data.savedTo ?? ''
  ready.value = true
  await nextTick()
  ta.value?.focus()
  // 光标放末尾，接着上次继续写
  const n = text.value.length
  ta.value?.setSelectionRange(n, n)

  window.sticky.onFocus(() => ta.value?.focus())
  window.addEventListener('beforeunload', onUnload)
})

/** 正在打的那半句在窗口关掉前再存一次，别指望主进程手里那份是最新的 */
function onUnload() {
  if (timer) clearTimeout(timer)
  void window.sticky.write(id, text.value)
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  window.removeEventListener('beforeunload', onUnload)
})

/* 输入框跟着内容长高这件事不做：便签是固定大小的一张纸，
   写多了自己滚。让它长高会把窗口越撑越大，最后屏幕上全是这张纸。 */

/**
 * 窗口标题跟着首行走。
 *
 * 开着五张便签时，任务栏悬停、Alt+Tab 里全是「便签」，分不出哪张是哪张。
 * 改 document.title 就够了 —— Electron 默认允许页面标题更新窗口标题，
 * 不用再过一道 IPC。
 */
watch(
  text,
  (t) => {
    const first = t.split(/\r?\n/).find((l) => l.trim()) ?? ''
    const name = first.replace(/^[#>\-*\s]+/, '').trim().slice(0, 20)
    document.title = name || '便签'
  },
  { immediate: true },
)
</script>

<template>
  <div class="note" :style="style">
    <header class="bar">
      <div class="grip" />
      <div class="acts">
        <!-- 换纸色。
             原来这里是一颗「当前的纸色」圆点，实际做出来等于看不见 ——
             它填的就是背景那个色，只剩一圈描边，在浅纸上像个脏点。
             纸色本来就铺满了整个窗口，用户不需要再被告知一次；
             这里要的是一个「能换颜色」的入口，所以用调色板图标。 -->
        <button class="ico" title="换纸色" @click="picker = !picker">
          <Palette :size="13" :stroke-width="2" />
        </button>
        <button
          class="ico"
          :class="{ on: pinned }"
          :title="pinned ? '不再钉在最上层' : '钉在最上层'"
          @click="togglePin"
        >
          <Pin v-if="pinned" :size="13" :stroke-width="2" />
          <PinOff v-else :size="13" :stroke-width="2" />
        </button>
        <button class="ico" title="存为笔记 (Ctrl+S)" @click="save">
          <Check v-if="savedTo" :size="14" :stroke-width="2.4" />
          <NotebookPen v-else :size="13" :stroke-width="2" />
        </button>
        <button class="ico" title="关闭 (Esc)" @click="close">
          <X :size="14" :stroke-width="2" />
        </button>
      </div>
    </header>

    <Transition name="sw">
      <div v-if="picker" class="swatches">
        <button
          v-for="p in PAPERS"
          :key="p.key"
          class="sw"
          :class="{ on: p.key === colorKey }"
          :style="{ background: p.bg }"
          :title="p.name"
          @click="pickColor(p.key)"
        />
      </div>
    </Transition>

    <textarea
      ref="ta"
      v-model="text"
      class="body"
      spellcheck="false"
      placeholder="想到什么就写…"
      @input="onInput"
      @keydown="onKey"
    />

    <Transition name="fade">
      <p v-if="hint" class="hint">{{ hint }}</p>
    </Transition>
  </div>
</template>

<style scoped>
.note {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* 顶部这条既是标题栏，也是唯一能拖动窗口的地方。
   按钮要反着声明 no-drag，否则点上去会变成拖窗口。 */
.bar {
  flex: none;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 10px;
  -webkit-app-region: drag;
}

.grip {
  flex: 1;
  min-width: 0;
  height: 100%;
}

.acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1px;
  -webkit-app-region: no-drag;
}

.ico {
  width: 24px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--p-dim);
  transition: background 130ms ease, color 130ms ease;
}
.ico:hover {
  background: var(--p-hover);
  color: inherit;
}
/* 钉住状态给个实心感：这个按钮是「开着」的开关，不是一次性动作 */
.ico.on {
  color: inherit;
}

.swatches {
  position: absolute;
  top: 34px;
  right: 8px;
  z-index: 5;
  display: flex;
  gap: 6px;
  padding: 6px 7px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.13);
}

.sw {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.18);
  transition: transform 120ms ease;
}
.sw:hover {
  transform: scale(1.16);
}
.sw.on {
  /* 选中的那张套一圈外环而不是把描边加粗：加粗会把色块本身挤小一圈，
     六颗颜色并排时看着像对不齐 */
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.3);
}

.body {
  flex: 1;
  min-height: 0;
  width: 100%;
  /* 上边留 6px：贴着标题栏开始写字，第一行看着像被顶到了框外 */
  padding: 6px 15px 14px;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.66;
  letter-spacing: 0.01em;
  user-select: text;
  /* 字距稍微松一点，中文密排的便条读起来会累 */
}
.body::placeholder {
  color: var(--p-dim);
  opacity: 0.75;
}

.body::-webkit-scrollbar {
  width: 7px;
}
.body::-webkit-scrollbar-thumb {
  background: color-mix(in oklab, var(--p-dim) 42%, transparent);
  border-radius: 4px;
}
.body::-webkit-scrollbar-thumb:hover {
  background: color-mix(in oklab, var(--p-dim) 66%, transparent);
}
.body::-webkit-scrollbar-track {
  background: transparent;
}

/* 提示条压在底部，不占正文高度：存完跳一行字出来，不该把正在写的东西往上顶 */
.hint {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 8px;
  margin: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.82);
  color: var(--p-dim);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

.sw-enter-active,
.sw-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}
.sw-enter-from,
.sw-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.96);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 180ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
