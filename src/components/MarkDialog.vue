<script setup lang="ts">
/**
 * 标记 —— 「给这个节点挑图标」和「给这篇笔记打标签」现在是同一个弹窗的两个页签。
 *
 * 为什么合：以前图标在右键菜单里、标签在侧栏底部一块独立的区域里。
 * 想给一篇笔记归类，得先记着「标签在那边」，再跑去那边点；反过来要给标签
 * 配个好看的图标则根本做不到。两件事各自占一个入口，彼此不通气。
 *
 * 合起来之后：右键任意一篇笔记 → 标记 → 图标 / 标签都在这一屏里，
 * 连「给标签本身挑一枚图标」也在这里做，素材库还是原来那一套。
 *
 * 为什么文件夹只有「图标」页：标签是笔记 frontmatter 里的一行，
 * 文件夹没有 frontmatter。强行给文件夹做标签，等于发明一种只在这个应用里
 * 存在、导出成 md 就会消失的概念。所以这里不给，也不装作能给。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Folder, FileText, Hash, Plus, Search, Shapes, X } from 'lucide-vue-next'
import { store } from '@/store'
import MarkIconGrid, { type MarkIcon } from '@/components/MarkIconGrid.vue'
import TagChip from '@/components/TagChip.vue'

const props = defineProps<{
  open: boolean
  /** 在给什么挑。只用于标题与预览 */
  name: string
  type: 'dir' | 'file'
  /** 笔记绝对路径。type==='file' 时用它读写标签 */
  path?: string
  /** 这篇笔记当前的标签，由调用方从树节点上取下来 */
  tags?: string[]
}>()
const emit = defineEmits<{
  (e: 'pickIcon', icon: MarkIcon | null): void
  (e: 'close'): void
}>()


const pane = ref<'icon' | 'tag'>('tag')
const q = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const grid = ref<InstanceType<typeof MarkIconGrid> | null>(null)

/** 正在给哪个标签挑图标；null = 不在挑 */
const iconFor = ref<string | null>(null)

/** 弹窗会话内这份笔记的标签副本。勾选是即时生效的，这里只是这一屏的显示源 */
const mine = ref<string[]>([])

const isFile = computed(() => props.type === 'file')
const hasTags = computed(() => isFile.value)

/** 全库标签清单（含计数）；正在搜索时按关键词筛，结果按名字排。
    store 里那份是按「用得多」排的 —— 在这儿不适用：勾选框要的是能顺着找，
    「按使用次数」在这里每次都不一样，手指会走错位置。 */
const known = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const list = store.allTags.value
  const filtered = kw ? list.filter((t) => t.name.toLowerCase().includes(kw)) : list
  return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
})

/** 搜索词本身也是一个候选标签：没这个标签时可以直接新建 */
const canCreate = computed(() => {
  const kw = q.value.trim()
  if (!kw) return false
  return !known.value.some((t) => t.name === kw)
})

const currentIcon = computed(() => (props.path ? store.iconOf(props.path) : null))

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    q.value = ''
    iconFor.value = null
    // 每次开都从外面重新取：两次打开之间这一篇可能已经被别处改过
    mine.value = [...(props.tags ?? [])]
    // 默认停在标签页：图标挑一次能用很久，标签才是隔三差五要动的东西。
    // 文件夹没有标签页可停 —— 硬停在那一页的话，眼前是空的搜索框和空列表，
    // 图标那一片压根没渲染出来，看着就像「点了更换图标什么都没发生」。
    pane.value = hasTags.value ? 'tag' : 'icon'
    await nextTick()
    searchInput.value?.focus()
  },
)

/* ── 图标页 ── */
function onPickIcon(ic: MarkIcon) {
  if (iconFor.value) {
    void store.setTagIcon(iconFor.value, ic)
    iconFor.value = null
    // 从标签页被送过来的，挑完就把人送回标签页去。
    // 停在图标页等于让人以为「刚才那步没生效」
    pane.value = 'tag'
    return
  }
  emit('pickIcon', ic)
}

/* ── 标签页 ── */
function has(tag: string) {
  return mine.value.includes(tag)
}

/** 勾掉一次就立刻写盘：这里没有「确定」按钮，所见即所得，
    否则用户以为勾了、按 Esc 关掉就全没了。 */
async function toggle(tag: string) {
  const path = props.path
  if (!path) return
  const next = has(tag) ? mine.value.filter((t) => t !== tag) : [...mine.value, tag]
  mine.value = next
  await store.setNoteTags(path, next)
}

async function createTag() {
  const name = q.value.trim()
  const path = props.path
  if (!name || !path) return
  q.value = ''
  if (has(name)) return
  mine.value = [...mine.value, name]
  await store.setNoteTags(path, mine.value)
  // 刚建出来的标签顺势配枚图标：这一步是「标签和图标合起来」真正的收益，
  // 顺手做掉的话几乎不用付成本，回头再补则会永远忘掉
  iconFor.value = name
  pane.value = 'icon'
}

/** 给某个标签换图标 → 切到图标页，那里点一下就写入 */
function pickIconFor(tag: string) {
  iconFor.value = tag
  pane.value = 'icon'
}

function onRestore() {
  if (iconFor.value) {
    void store.setTagIcon(iconFor.value, null)
    iconFor.value = null
    pane.value = 'tag'
    return
  }
  emit('pickIcon', null)
}

function onClose() {
  iconFor.value = null
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') onClose()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ip-mask" @click.self="onClose" @keydown="onKey">
      <div class="ip" role="dialog" aria-modal="true" :aria-label="hasTags ? '标记' : '更换图标'">
        <header class="ip-head">
          <span class="ip-ic">
            <Folder v-if="type === 'dir'" :size="14" :stroke-width="1.9" />
            <FileText v-else :size="14" :stroke-width="1.9" />
          </span>
          <!-- 标题跟着「这一次能改什么」走。文件夹叫「标记」名不副实：
               点的是右键菜单里的「更换图标」，弹出来却写「标记」，人会对不上账。 -->
          <span class="ip-title">{{ hasTags ? '标记' : '更换图标' }}</span>
          <span class="ip-name">{{ name }}</span>
          <button class="ip-x" title="关闭" @click="onClose">
            <X :size="15" :stroke-width="1.9" />
          </button>
        </header>

        <!-- 文件夹只有图标页，所以连页签都不出现：
             给一个人看一个不该点的按钮，比不给更糟 -->
        <div v-if="hasTags" class="ip-tabs">
          <button :class="{ on: pane === 'tag' }" @click="pane = 'tag'">
            <Hash :size="12" :stroke-width="2.2" /><span>标签</span>
          </button>
          <button :class="{ on: pane === 'icon' }" @click="pane = 'icon'">
            <Shapes :size="12" :stroke-width="2.2" /><span>图标</span>
          </button>
        </div>

        <!-- ── 标签页（只有笔记有） ── -->
        <div v-if="pane === 'tag' && hasTags" class="ip-pane">
          <label class="ip-search ip-search-row">
            <Search :size="12" :stroke-width="2" />
            <input
              ref="searchInput"
              v-model="q"
              type="text"
              placeholder="搜索或新建标签…"
              spellcheck="false"
              @keydown.enter.prevent="createTag"
            />
            <button
              v-if="canCreate"
              class="ip-new"
              :title="`新建标签「${q.trim()}」`"
              @click="createTag"
            >
              <Plus :size="12" :stroke-width="2.4" /><span>新建</span>
            </button>
          </label>

          <div class="ip-list">
            <button
              v-for="t in known"
              :key="t.name"
              class="ip-row"
              :class="{ on: has(t.name) }"
              @click="toggle(t.name)"
            >
              <span class="ip-box" :class="{ on: has(t.name) }" aria-hidden="true"></span>
              <span class="ip-row-ico" title="给这个标签换图标" @click.stop="pickIconFor(t.name)">
                <TagChip :name="t.name" :size="12" />
              </span>
              <span class="ip-row-n">{{ t.count }}</span>
            </button>

            <p v-if="known.length === 0" class="ip-empty-lg">
              还没有标签。在上面输入名字回车，就能新建并打给这篇笔记。
            </p>
          </div>
        </div>

        <!-- ── 图标页 ── -->
        <MarkIconGrid
          v-else
          ref="grid"
          :current="iconFor ? store.tagIconOf(iconFor) : currentIcon"
          class="ip-pane-grid"
          @pick="onPickIcon"
        />

        <footer class="ip-foot">
          <span v-if="iconFor" class="ip-foot-hint">正在给「{{ iconFor }}」挑图标</span>
          <button class="ip-btn ghost" @click="onRestore">
            {{ iconFor ? '去掉这枚图标' : '恢复默认' }}
          </button>
          <button class="ip-btn" @click="onClose">完成</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ip-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--n-mask);
  backdrop-filter: blur(2px);
  animation: ip-fade 120ms var(--n-ease);
}

.ip {
  width: 520px;
  max-width: calc(100vw - 40px);
  height: 440px;
  max-height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
  animation: ip-in 140ms var(--n-ease);
}

.ip-head {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--n-line);
  color: var(--n-fg-dim);
}

.ip-ic {
  display: inline-flex;
  color: var(--n-accent);
}

.ip-ic svg {
  fill: none;
  stroke: currentColor;
}

.ip-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--n-fg);
}

.ip-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--n-fg-faint);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ip-x {
  padding: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.ip-x svg {
  fill: none;
  stroke: currentColor;
}

.ip-x:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.ip-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 8px 12px 0;
}

.ip-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 12px;
  border-radius: var(--n-r-sm) var(--n-r-sm) 0 0;
  font-size: 12px;
  color: var(--n-fg-dim);
  border-bottom: 2px solid transparent;
}

.ip-tabs button svg {
  fill: none;
  stroke: currentColor;
}

.ip-tabs button.on {
  color: var(--n-accent);
  border-bottom-color: var(--n-accent);
}

.ip-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ip-pane-grid {
  flex: 1;
  min-height: 0;
}

.ip-search-row {
  flex: none;
  margin: 10px 12px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-sm);
  background: var(--n-surface);
  color: var(--n-fg-faint);
}

.ip-search-row svg {
  flex: none;
  fill: none;
  stroke: currentColor;
}

.ip-search-row input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--n-fg);
  outline: none;
}

.ip-new {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 8px;
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--n-accent);
  background: var(--n-accent-soft);
}

.ip-new svg {
  fill: none;
  stroke: currentColor;
}

.ip-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 10px;
}

.ip-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  text-align: left;
}

.ip-row:hover {
  background: var(--n-bg);
}

.ip-row.on {
  color: var(--n-fg);
}

/* 勾选框：自定义而不是 `<input type=checkbox>`，
   因为原生那个在低 dpi 下的对齐与配色都跟这套 UI 对不上 */
.ip-box {
  flex: none;
  width: 13px;
  height: 13px;
  border-radius: 3.5px;
  border: 1.5px solid var(--n-line-strong);
  position: relative;
}

.ip-row.on .ip-box {
  border-color: var(--n-accent);
  background: var(--n-accent);
}

.ip-row.on .ip-box::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 0.5px;
  width: 4px;
  height: 7px;
  border: solid #fff;
  border-width: 0 1.6px 1.6px 0;
  transform: rotate(42deg);
}

.ip-row-ico {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
}

.ip-row-ico:hover {
  color: var(--n-accent);
}

.ip-row-n {
  flex: none;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-faint);
}

.ip-empty-lg {
  margin: 18px 8px 0;
  text-align: center;
  font-size: 12px;
  line-height: 1.7;
  color: var(--n-fg-faint);
}

.ip-foot {
  flex: none;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 12px;
  border-top: 1px solid var(--n-line);
}

.ip-foot-hint {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--n-fg-faint);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ip-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: var(--n-r-sm);
  font-size: 12.5px;
  color: var(--n-fg-dim);
  background: var(--n-surface);
  border: 1px solid var(--n-line);
}

.ip-btn:hover {
  color: var(--n-fg);
  background: var(--n-raised);
}

.ip-btn.ghost {
  background: none;
  border-color: transparent;
  color: var(--n-fg-faint);
}

.ip-btn.ghost:hover {
  color: var(--n-danger);
  background: var(--n-danger-soft);
}

@keyframes ip-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes ip-in {
  from { opacity: 0; transform: translateY(-8px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
</style>
