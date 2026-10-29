<script setup lang="ts">
/**
 * 中间那一列的「链接」视图：这一篇和别的笔记之间，两个方向各是什么。
 *
 * 分两段，因为它回答的是两个不同的问题：
 *  · **出链** —— 我这篇提到了谁。数据就在当前这篇正文里，读一次就有。
 *  · **反向链接** —— 谁提到了我这篇。得把工作区读一遍才找得到。
 *
 * 为什么放在同一栏：人查这两个的时机是同一个 —— 「我写到这里，还有哪篇
 * 跟这事有关」。分成两个页签等于让人每次多按一下，还常常只看到一半。
 *
 * 反向链接不会每次都读全库：文件按「路径 + 修改时间」缓存，改过的才重读；
 * 工作区特别大时只扫前若干篇，并在界面上说清楚扫了多少，而不是假装
 * 整个工作区都查过了。
 *
 * 链接认哪些写法、名字怎么落到具体文件，规则在 `@/editor/wiki-resolve`，
 * 和预览、关系图共用一份。
 */
import { computed, ref, watch } from 'vue'
import { Link2, RefreshCw } from 'lucide-vue-next'
import { store } from '@/store'
import { outgoingLinks, resolveWikiNote } from '@/editor/wiki-resolve'

const { state } = store

/** 一次最多扫这么多篇。再多就明显卡住首次打开了，宁可说清楚 */
const MAX_FILES = 400
/** 同时读几篇。开太大反而被 IPC 排队拖慢 */
const POOL = 8

interface Row {
  path: string
  name: string
  folder: string
  lines: string[]
}

/** 出链：可能指向一篇不存在的笔记，那种没有 path，点了也没地方去 */
interface OutRow {
  key: string
  name: string
  alias?: string
  embed: boolean
  path: string | null
  folder: string
}

const rows = ref<Row[]>([])
const outRows = ref<OutRow[]>([])
const scanning = ref(false)
/** 已经看完的篇数，给进度条用 */
const done = ref(0)
const total = ref(0)
const limited = ref(false)

/** 路径 + mtime → 正文。改了才会失效，没改的直接复用 */
const fileCache = new Map<string, { mtime: number; text: string }>()

const targetName = computed(() => store.activeName.value)
const root = computed(() => state.root ?? '')

function folderOf(p: string) {
  const rel = root.value && p.startsWith(root.value) ? p.slice(root.value.length) : p
  const parts = rel.replace(/^[\\/]+/, '').split(/[\\/]/)
  parts.pop()
  return parts.join(' / ') || '根目录'
}

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 指向某一篇的链接。前一半认 [[…]]，后一半认 (…md) */
function linkRe(name: string) {
  const n = esc(name)
  return new RegExp(
    `\\[\\[\\s*(?:[^\\]|]*\\/)?${n}(?:\\.md)?\\s*(?:[|#][^\\]]*)?\\]\\]` +
      `|\\]\\([^)]*${n}\\.md[^)]*\\)`,
    'i',
  )
}

async function readCached(path: string, mtime: number) {
  const hit = fileCache.get(path)
  if (hit && hit.mtime === mtime) return hit.text
  try {
    const text = (await window.api.readNote(path)) ?? ''
    fileCache.set(path, { mtime, text })
    return text
  } catch {
    fileCache.set(path, { mtime, text: '' })
    return ''
  }
}

/**
 * 出链：读当前这篇，把里面指向别处的名字落到文件上。
 *
 * 落不到文件上的**照样列出来** —— 「我写了 [[某某]] 但那篇还没建」正是
 * 最该被看见的一件事，藏起来等于让人永远想不起来去补。
 */
function collectOutgoing(text: string) {
  const files = store.allFiles.value
  const seen = new Set<string>()
  const out: OutRow[] = []
  for (const l of outgoingLinks(text)) {
    const path = resolveWikiNote(l.target, files, state.root)
    const key = path ?? `?${l.target}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      name: path ? (path.split(/[\\/]/).pop() ?? l.target).replace(/\.md$/i, '') : l.target,
      alias: l.alias,
      embed: l.embed,
      path,
      folder: path ? folderOf(path) : '这篇还没建',
    })
  }
  outRows.value = out
}

async function scan() {
  const target = state.activePath
  const name = targetName.value
  rows.value = []
  done.value = 0
  total.value = 0
  limited.value = false
  if (!target || !name) return

  const all = store.allFiles.value.filter((f) => f.path !== target)
  const files = all.slice(0, MAX_FILES)
  limited.value = all.length > files.length
  total.value = files.length
  scanning.value = true

  const re = linkRe(name)
  const found: Row[] = []
  let cursor = 0

  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= files.length) return
      const f = files[i]
      const text = await readCached(f.path, f.mtime ?? 0)
      done.value += 1
      if (!text || !re.test(text)) continue
      // 命中的行各摘一行出来当上下文，最多两条 —— 认出「在哪儿提到的」就够了
      const lines = text
        .split(/\r?\n/)
        .filter((l) => re.test(l))
        .slice(0, 2)
        .map((l) => l.trim().slice(0, 120))
      found.push({ path: f.path, name: f.name.replace(/\.md$/i, ''), folder: folderOf(f.path), lines })
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, worker))
  scanning.value = false

  // 按路径排一下，顺序稳定，切来切去不会跳
  found.sort((a, b) => a.path.localeCompare(b.path))
  rows.value = found
}

watch(
  () => [state.activePath, state.tree, state.root],
  () => void scan(),
  { immediate: true },
)

/* 出链跟着正文走，不跟着文件走。
   从 `state.draft` 里取而不是去读一遍盘：刚敲下的 `[[…]]` 还没保存，
   读盘读到的是上一版，于是「我明明写了它却不出现」—— 那种延迟会让人
   以为功能坏了。大纲也吃这一份数据，所以这里是同一个时机、同一份原文。 */
watch(
  () => [state.activePath, state.draft] as const,
  ([p, raw]) => {
    if (!p) {
      outRows.value = []
      return
    }
    collectOutgoing(raw ?? '')
  },
  { immediate: true },
)

function open(path: string) {
  void store.openNote(path)
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

async function refresh() {
  fileCache.clear()
  await scan()
  toast('已重扫工作区')
}
</script>

<template>
  <div class="qv">
    <div class="pn-head">
      <span class="pn-ico"><Link2 :size="13" :stroke-width="1.9" /></span>
      <span class="pn-title">链接</span>
      <span class="pn-sub">出 {{ outRows.length }} · 入 {{ rows.length }}</span>
      <span class="pn-x">
        <button class="qv-btn" title="重扫工作区" :disabled="scanning" @click="refresh">
          <RefreshCw :class="{ spin: scanning }" :size="12" :stroke-width="2" />
        </button>
      </span>
    </div>

    <div class="pn-body">
      <div v-if="!state.activePath" class="pn-empty">先打开一篇笔记，这里会列出它的出链和被引用</div>

      <template v-else>
        <!-- ── 反向链接：谁提到了当前这篇 ──
             放在上面，因为这一段是「我不知道的事」：这篇被人引用了没有、
             从哪儿链过来的。出链是我自己刚写下的，本来就知道。 -->
        <div class="qv-sec">
          <span class="qv-sec-t">反向链接</span>
          <span class="qv-sec-n">{{ scanning ? `${done}/${total}` : rows.length }}</span>
        </div>

        <p v-if="scanning && rows.length === 0" class="qv-hint">正在翻工作区里的笔记…</p>

        <p v-else-if="rows.length === 0" class="qv-hint">
          还没有别的笔记提到这一篇。在别处写 <code>[[{{ targetName }}]]</code>，它就会出现在这里。
        </p>

        <template v-else>
          <p v-if="limited" class="pn-tip">工作区里笔记很多，这次只扫了前 {{ MAX_FILES }} 篇。</p>
          <div class="pn-list">
            <button
              v-for="r in rows"
              :key="r.path"
              class="pn-row qv-row qv-back"
              :title="r.path"
              @click="open(r.path)"
            >
              <span class="qv-name">{{ r.name }}</span>
              <span class="qv-folder">{{ r.folder }}</span>
              <span v-for="(l, i) in r.lines" :key="i" class="qv-line">{{ l }}</span>
            </button>
          </div>
        </template>

        <!-- ── 出链：当前这篇提到了谁 ── -->
        <div class="qv-sec">
          <span class="qv-sec-t">出链</span>
          <span class="qv-sec-n">{{ outRows.length }}</span>
        </div>

        <p v-if="!outRows.length" class="qv-hint">
          这篇还没指向别处。正文里打 <code>[[</code> 就能选一篇连过去。
        </p>

        <div v-else class="pn-list">
          <button
            v-for="l in outRows"
            :key="l.key"
            class="pn-row qv-row qv-out"
            :class="{ missing: !l.path }"
            :disabled="!l.path"
            :title="l.path ?? `工作区里还没有「${l.name}」这篇笔记`"
            @click="l.path && open(l.path)"
          >
            <span class="qv-name">
              <span class="qv-name-t">{{ l.name }}</span>
              <span v-if="l.embed" class="qv-flag">嵌入</span>
              <span v-else-if="l.alias" class="qv-flag">{{ l.alias }}</span>
            </span>
            <span class="qv-folder">{{ l.folder }}</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.qv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.qv-btn {
  padding: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
}

.qv-btn svg {
  fill: none;
  stroke: currentColor;
}

.qv-btn:hover:not(:disabled) {
  background: var(--n-raised);
  color: var(--n-accent);
}

.qv-btn:disabled {
  opacity: 0.6;
}

.spin {
  animation: qv-spin 900ms linear infinite;
}

@keyframes qv-spin {
  to { transform: rotate(360deg); }
}

.qv-row {
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  height: auto;
  padding: 8px 10px;
}

/* 分段标题：这一栏里住着两种不同的问题，得让人一眼看出读到哪儿了。
   字比正文小、比分割线响，位置靠左 —— 它是个路标，不是标题。 */
.qv-sec {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 6px;
  margin-top: 10px;
}

.qv-sec:first-child {
  margin-top: 0;
}

.qv-sec-t {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--n-fg-dim);
}

.qv-sec-n {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
  padding: 0 5px;
  border-radius: 999px;
  background: var(--n-raised);
}

/* 空状态用一行小字，不用整块 .pn-empty：那两块是并列的，
   任何一块空着都撑出 34px 上下留白，这一栏就没法一眼看完 */
.qv-hint {
  font-size: 11px;
  line-height: 1.7;
  color: var(--n-fg-faint);
  padding: 2px 4px 6px;
}

.qv-hint code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--n-code-bg);
  font-family: var(--n-font-mono);
  font-size: 10.5px;
}

.qv-name {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.qv-name-t {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 嵌入与别名：一线很小的标，说明「这一条为什么长得和别的不同」 */
.qv-flag {
  flex: none;
  font-size: 9.5px;
  font-weight: 400;
  line-height: 1.5;
  padding: 0 4px;
  border-radius: 3px;
  color: var(--n-fg-faint);
  background: var(--n-raised);
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 指向一篇还不存在的笔记：名字划虚线 + 不可点。
   按下去什么都不发生比标出来更糟 —— 人会以为自己点错了。
   只划名字那一条，下面的「这篇还没建」不划：两条虚线叠在一起像表格线。 */
.qv-out.missing {
  cursor: default;
}

/* 不可点的行不该有 hover 高亮 —— 那点反馈等于在说「按我」 */
.qv-out.missing:hover {
  background: transparent;
}

.qv-out.missing .qv-name {
  color: var(--n-fg-faint);
}

.qv-out.missing .qv-name-t {
  border-bottom: 1px dashed color-mix(in oklab, var(--n-fg-faint) 55%, transparent);
  padding-bottom: 1px;
}

.qv-folder {
  font-size: 10px;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 命中的那一行原文：让「在哪儿提到的」一眼可见 */
.qv-line {
  font-family: var(--n-font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--n-fg-dim);
  background: color-mix(in oklab, var(--n-accent-soft) 62%, transparent);
  border-radius: 4px;
  padding: 2px 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
