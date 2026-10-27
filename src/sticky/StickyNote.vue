<script setup lang="ts">
/**
 * 一张便签。
 *
 * 设计上只有一个决心：**打开就能打字**。所以这里没有工具栏、没有标题栏
 * 输入框、没有块级排版 —— 那些东西每一样都在抢「按下快捷键到第一个字
 * 出现在屏幕上」的那段时间。要排版，点「存为笔记」进主程序去弄。
 *
 * 但「纯文本」和「什么也看不出来」是两件事。正文底下叠了一层镜像
 * （见 sticky/rich.ts）：`#mysql` 会淡出一块底色，`- [ ]` 变成一个能点的
 * 方框，点一下就把文本里的 `[ ]` 改成 `[x]` —— 存的还是纯文本，只是
 * 写的时候认得出自己在写什么。
 *
 * 正文里打出来的 `#标签` 同时会挂到这张纸的记录上，列表里就能按它筛。
 * 只增不减：手打的标签不该被正文扫描悄悄抹掉。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, NotebookPen, Palette, Pin, PinOff, X } from 'lucide-vue-next'
import { PAPERS, paperOf } from './colors'
import { mirrorHtml, tagsInText, toggleBox } from './rich'

const id = new URLSearchParams(location.search).get('id') ?? ''

const text = ref('')
const pinned = ref(true)
const colorKey = ref('amber')
const savedTo = ref('')
const tags = ref<string[]>([])
const ready = ref(false)
const picker = ref(false)
const hint = ref('')

/* ── 贴在纸底下的图 ──
   正文是纯文本，底下还压着一层靠逐行对齐的镜像：图要是插进正文里，
   那层对齐就废了。所以图单独挂在底部的托盘上，正文一个字不提。 */
const shots = ref<string[]>([])
const shotSrc = ref<Record<string, string>>({})
const viewing = ref('')

const ta = ref<HTMLTextAreaElement | null>(null)
const mirrorEl = ref<HTMLElement | null>(null)
const paper = computed(() => paperOf(colorKey.value))

const style = computed(() => ({
  background: paper.value.bg,
  color: paper.value.fg,
  '--p-dim': paper.value.dim,
  '--p-hover': paper.value.hover,
  /* textarea 自己的字是透明的（真正显示的是下面那层镜像），
     所以光标得单独指回正文色，否则 caret-color: auto 会跟着透明 */
  '--p-fg': paper.value.fg,
}))

const html = computed(() => mirrorHtml(text.value))

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
  syncTags()
}

function onInput() {
  savedTo.value = ''
  scheduleSave()
}

/**
 * 正文里的 `#tag` 落到记录上。只加不删 —— 用户在标记弹窗里手打过一个
 * 「运维」，正文里没写 `#运维`，扫描结果里就没有它；照着扫描结果覆盖一遍
 * 等于把手工分类全抹了。
 */
function syncTags() {
  const found = tagsInText(text.value)
  if (!found.length) return
  const next = [...new Set([...tags.value, ...found])]
  if (next.length === tags.value.length) return
  tags.value = next
  // 主进程拿自己的最新值合并后再回传全量：这个窗口可能开着很久，
  // 期间列表那边给它补过标签，本地这份是旧的
  void window.sticky.addTags(id, found).then((all) => {
    if (Array.isArray(all)) tags.value = all
  })
}

/* ── 关闭 ──
   先把最后这一段写下去再关。直接发 close 的话，主进程收尾用的是
   内存里上一次上报的正文，正在打的这半句就丢了。 */
async function close() {
  await flush()
  await window.sticky.close(id)
}

/* ── 存为笔记 ──
   存完这张纸会**自己收进列表的抽屉**（主进程那边默认归档）：搬进库就是
   它的终点，留在桌面上就是同一份东西的第二份。留 700ms 让提示亮一下，
   用户才知道刚才那一闪发生了什么。这期间又开始打字，就说明他还想写 ——
   那就别关，把「留在桌面上」说清楚。 */
async function save() {
  await flush()
  const r = await window.sticky.saveToVault(id)
  if (!(r.ok && r.rel)) {
    hint.value = r.error ?? '没存进去'
    window.setTimeout(() => (hint.value = ''), 3000)
    return
  }
  savedTo.value = r.rel
  hint.value = `已存入 ${r.rel}`
  const snapshot = text.value
  window.setTimeout(() => {
    if (text.value !== snapshot) {
      hint.value = '已存入，这张留在桌面上继续写'
      window.setTimeout(() => (hint.value = ''), 2600)
      return
    }
    void window.sticky.close(id)
  }, 700)
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
 * 点镜像层里的待办框。事件是从 span 上冒上来的（那个 span 是唯一
 * pointer-events: auto 的东西，其余部分点击直接穿透到 textarea）。
 */
function onMirrorClick(e: MouseEvent) {
  const el = (e.target as HTMLElement | null)?.closest?.('.cb') as HTMLElement | null
  if (!el) return
  // 不 preventDefault 的话，点击会把光标挪到框里，下面又改了一次文本，位置会跳
  e.preventDefault()
  const li = Number(el.dataset.l)
  if (!Number.isInteger(li)) return
  const next = toggleBox(text.value, li)
  if (next == null) return
  text.value = next
  scheduleSave()
  ta.value?.focus()
}

/** 两层各滚各的是因为 textarea 才是真的滚动容器，镜像得跟着它走 */
function syncScroll() {
  if (mirrorEl.value && ta.value) mirrorEl.value.scrollTop = ta.value.scrollTop
}

/* ── 贴图 ──
   走托盘而不是往正文里插 Markdown：正文是纯文本 + 逐行对齐的镜像层，
   任何一张图都会把那层对齐撑歪。托盘在最低下一行，挤掉的是正文高度，
   不是对齐关系。 */

async function loadShots(names: string[]) {
  shots.value = names
  const add: Record<string, string> = {}
  await Promise.all(
    names.map(async (n) => {
      if (shotSrc.value[n]) return
      try {
        add[n] = await window.sticky.shotUrl(n)
      } catch {
        /* 读不出来就这张不显示，不至于把整条托盘弄没 */
      }
    }),
  )
  if (Object.keys(add).length) shotSrc.value = { ...shotSrc.value, ...add }
}

/** 剪贴板 / 拖进来的图 → 存进这张纸的 media/ */
async function absorb(files: File[]) {
  const imgs = files.filter((f) => f.type.startsWith('image/'))
  if (!imgs.length) return
  let names = shots.value
  for (const f of imgs) {
    const buf = new Uint8Array(await f.arrayBuffer())
    const ext = (f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5)
    const r = await window.sticky.addShot(id, buf, ext || 'png')
    if (r.ok && r.shots) names = r.shots
    else if (r.error) {
      hint.value = r.error
      window.setTimeout(() => (hint.value = ''), 3000)
    }
  }
  await loadShots(names)
  ta.value?.focus()
}

/** 只接管「剪贴板里就是图」这一种情况；带文字的照样让它正常粘贴 */
function onPaste(e: ClipboardEvent) {
  const dt = e.clipboardData
  if (!dt) return
  const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  e.preventDefault()
  void absorb(files)
}

function onDrop(e: DragEvent) {
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.some((f) => f.type.startsWith('image/'))) return
  e.preventDefault()
  void absorb(files)
}

/** 只对「拖的是文件」放行，否则会连文字拖拽也一并接管 */
function onDragOver(e: DragEvent) {
  if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
}

async function dropShot(name: string) {
  const names = await window.sticky.removeShot(id, name)
  shots.value = names
  if (viewing.value === name) viewing.value = ''
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
    if (viewing.value) {
      viewing.value = ''
      ta.value?.focus()
      return
    }
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
  tags.value = data.tags ?? []
  await loadShots(data.shots ?? [])
  ready.value = true
  await nextTick()
  ta.value?.focus()
  // 光标放末尾，接着上次继续写
  const n = text.value.length
  ta.value?.setSelectionRange(n, n)

  window.sticky.onFocus(() => ta.value?.focus())
  // 列表里右键换了纸色：这张纸正开着，得跟着换
  window.sticky.onColor((k) => {
    colorKey.value = k
  })
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
  <div class="note" :style="style" @dragover="onDragOver" @drop="onDrop">
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
        <button class="ico" title="存为笔记并收起来 (Ctrl+S)" @click="save">
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

    <!-- 正文是两层叠出来的：
         · 下面 .mirror 用同一套字体行高把字画成彩色（`#tag` 有底色、
           待办框是能点的方框），它不接收指针事件，除了那些方框；
         · 上面 .body 是真的 textarea，字设成透明，只剩光标和选区。
         两层的字体/行高/内边距/滚动条宽度必须一模一样，差一个像素，
         字就会错位成鬼影 —— 改这里任何一条尺寸都要两边一起改。 -->
    <div class="body-wrap">
      <div
        ref="mirrorEl"
        class="mirror"
        aria-hidden="true"
        v-html="html"
        @click="onMirrorClick"
      />
      <textarea
        ref="ta"
        v-model="text"
        class="body"
        spellcheck="false"
        placeholder="想到什么就写…（截图可以直接 Ctrl+V 贴进来）"
        @input="onInput"
        @keydown="onKey"
        @scroll="syncScroll"
        @paste="onPaste"
      />
    </div>

    <!-- 图挂在纸底下这一条托盘里。正文里一个字不提 —— 图进正文就会把
         镜像层的逐行对齐撑歪，那层一歪，打字时字就叠成鬼影。 -->
    <div v-if="shots.length" class="tray">
      <div v-for="n in shots" :key="n" class="shot">
        <img :src="shotSrc[n]" :alt="''" draggable="false" @click="viewing = n" />
        <button class="del" title="去掉这张图" @click.stop="dropShot(n)">
          <X :size="10" :stroke-width="2.6" />
        </button>
      </div>
    </div>

    <Transition name="fade">
      <p v-if="hint" class="hint">{{ hint }}</p>
    </Transition>

    <!-- 点开看大图。便签窗口本身很小，缩略图只够认出是哪张 -->
    <Transition name="fade">
      <div v-if="viewing" class="zoom" @click="viewing = ''">
        <img :src="shotSrc[viewing]" :alt="''" />
      </div>
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
  z-index: 8;
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

/* 两层共用的排版。抽成一条规则是为了让它们不会各写一份然后慢慢走偏 */
.body-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
}

.mirror,
.body {
  /* 上边留 6px：贴着标题栏开始写字，第一行看着像被顶到了框外 */
  padding: 6px 15px 14px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.66;
  letter-spacing: 0.01em;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  border: 0;
  /* textarea 的 UA 样式本来就是 border-box，镜像是个 div —— 不显式对齐的话
     两边的内容宽度差出一圈内边距，换行位置就开始错 */
  box-sizing: border-box;
  scrollbar-gutter: stable;
}

/* 镜像层：只负责画字。它整层不接指针事件，唯一的例外是下面那些待办框 */
.mirror {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  pointer-events: none;
  user-select: none;
  color: inherit;
}
/* 滚动条只是用来占住和 textarea 一样的宽度，不能真的显形 */
.mirror::-webkit-scrollbar {
  width: 7px;
}
.mirror::-webkit-scrollbar-thumb,
.mirror::-webkit-scrollbar-track {
  background: transparent;
}

/* 真输入框：字是透明的（不然会和镜像层叠成双影），光标和选区留着 */
.body {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  resize: none;
  outline: none;
  background: transparent;
  color: transparent;
  caret-color: var(--p-fg);
  user-select: text;
}
.body::placeholder {
  color: var(--p-dim);
  opacity: 0.75;
}
/* 选区色块要压在镜像层上面、又不能把字完全盖住，用一层很淡的墨 */
.body::selection {
  background: rgba(0, 0, 0, 0.16);
  color: transparent;
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

/* ── 镜像层里的两枚记号 ──
   注意：v-html 插进来的节点拿不到 scoped 的 data 属性，所以必须用 :deep() */

/* `#tag` 只加一层极淡的底色，不改字重也不改字号 —— 改宽度就会和上面那层错位 */
.mirror :deep(.tg) {
  background: rgba(0, 0, 0, 0.075);
  border-radius: 3px;
}

/* 待办行前面那个 `- ` 是留给「存为笔记」的 Markdown 记号，在这一层压淡：
   opacity 不改宽度，两层仍然严格对齐 */
.mirror :deep(.li) {
  opacity: 0.32;
}

/* 待办框：文字留着占位但染成透明的，方块和勾都是画上去的 */
.mirror :deep(.cb) {
  position: relative;
  z-index: 3;
  color: transparent;
  cursor: pointer;
  pointer-events: auto;
}
.mirror :deep(.cb::before) {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  box-sizing: border-box;
  width: 13px;
  height: 13px;
  transform: translate(-50%, -50%);
  border-radius: 3.5px;
  border: 1.5px solid color-mix(in oklab, var(--p-dim) 88%, transparent);
  background: rgba(255, 255, 255, 0.46);
  transition:
    background 110ms ease,
    border-color 110ms ease;
}
.mirror :deep(.cb:hover::before) {
  border-color: var(--p-dim);
  background: rgba(255, 255, 255, 0.72);
}
.mirror :deep(.cb.on::before) {
  /* 用正文色而不是次级色：次级色在白勾下面太淡，勾会糊成一团 */
  background: color-mix(in oklab, var(--p-fg) 72%, transparent);
  border-color: transparent;
}
.mirror :deep(.cb.on::after) {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 7px;
  transform: translate(-50%, -58%) rotate(42deg);
  border-right: 1.6px solid #fff;
  border-bottom: 1.6px solid #fff;
  border-radius: 1px;
}

/* 图托盘：横着排，超出就横向滚。高度写死 56px —— 托盘一变高，
   正文可视区就跟着变，写着写着纸面会跳一下。 */
.tray {
  flex: none;
  display: flex;
  gap: 6px;
  height: 56px;
  padding: 6px 12px 6px 15px;
  overflow-x: auto;
  overflow-y: hidden;
}
.tray::-webkit-scrollbar {
  height: 5px;
}
.tray::-webkit-scrollbar-thumb {
  background: color-mix(in oklab, var(--p-dim) 40%, transparent);
  border-radius: 3px;
}
.tray::-webkit-scrollbar-track {
  background: transparent;
}

.shot {
  position: relative;
  flex: none;
  height: 44px;
  border-radius: 5px;
  overflow: hidden;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12);
  cursor: zoom-in;
}
.shot img {
  display: block;
  height: 100%;
  width: auto;
  max-width: 130px;
  object-fit: cover;
}

/* 删除键只在悬停时出现：托盘是随手放图的地方，平时不该有一排叉号 */
.shot .del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 15px;
  height: 15px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.52);
  color: #fff;
  opacity: 0;
  transition: opacity 120ms ease;
}
.shot:hover .del {
  opacity: 1;
}

/* 看大图。铺满整张纸，点任意处退出 */
.zoom {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 10px;
  background: rgba(0, 0, 0, 0.74);
  cursor: zoom-out;
}
.zoom img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 6px;
  object-fit: contain;
}

/* 提示条压在底部，不占正文高度：存完跳一行字出来，不该把正在写的东西往上顶 */
.hint {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 8px;
  z-index: 4;
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
