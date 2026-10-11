<script setup lang="ts">
/**
 * 附件库 + 回收站。
 *
 * 两个都是「工作区层面的东西」而不是某一篇笔记的，所以共用一个对话框：
 *  - 附件库：attachments/ 下的图片视频，挑一个插进正在写的笔记
 *  - 回收站：删掉的笔记，能原路恢复（删之前在哪个目录就回哪个目录）
 *
 * 插入不走 props 层层传，而是抛一个 nota:insert 事件——
 * 附件库可能在侧栏被唤起，让它直接认识编辑器会把两边焊死。
 */
import { computed, ref, watch } from 'vue'
import {
  FileText,
  Image as ImageIcon,
  RotateCcw,
  Trash2,
  Video,
  X,
} from 'lucide-vue-next'
import { store } from '@/store'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

type Tab = 'attach' | 'trash'
const tab = ref<Tab>('attach')

interface Attach {
  rel: string
  name: string
  size: number
  mtime: number
  isVideo: boolean
  url?: string
}
interface TrashItem {
  key: string
  rel: string
  name: string
  deletedAt: number
  size: number
}

const attach = ref<Attach[]>([])
const trash = ref<TrashItem[]>([])
const loading = ref(false)

const root = computed(() => store.state.root ?? '')

async function loadAttach() {
  if (!root.value) return
  loading.value = true
  try {
    const list = await window.api.attachList(root.value)
    // 缩略图要逐个换算成可加载的 URL，和预览区走同一条路
    attach.value = await Promise.all(
      list.map(async (a) => ({
        ...a,
        url: (await window.api.resolveMedia(root.value, a.rel)) ?? '',
      })),
    )
  } catch {
    attach.value = []
  } finally {
    loading.value = false
  }
}

async function loadTrash() {
  if (!root.value) return
  loading.value = true
  try {
    trash.value = await window.api.trashList(root.value)
  } catch {
    trash.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (tab.value === 'attach') void loadAttach()
    else void loadTrash()
  },
)
watch(tab, (t) => {
  if (!props.open) return
  if (t === 'attach') void loadAttach()
  else void loadTrash()
})

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

function insert(a: Attach) {
  const text = a.isVideo
    ? `<video src="${a.rel}" controls></video>`
    : `![${a.name.replace(/\.[^.]+$/, '')}](${a.rel})`
  window.dispatchEvent(new CustomEvent('nota:insert', { detail: text }))
  toast('已插入到当前笔记')
}

async function removeAttach(a: Attach) {
  if (!root.value) return
  await window.api.attachDelete(root.value, a.rel)
  attach.value = attach.value.filter((x) => x.rel !== a.rel)
  toast(`已删除 ${a.name}`)
}

async function restore(t: TrashItem) {
  await window.api.trashRestore(root.value, t.key)
  trash.value = trash.value.filter((x) => x.key !== t.key)
  await store.refreshTree()
  toast(`已恢复到 ${t.rel}`)
}

async function purge(t: TrashItem) {
  await window.api.trashPurge(root.value, t.key)
  trash.value = trash.value.filter((x) => x.key !== t.key)
  toast(`已彻底删除 ${t.name}`)
}

async function emptyTrash() {
  if (trash.value.length === 0) return
  await window.api.trashEmpty(root.value)
  trash.value = []
  toast('回收站已清空')
}

function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function timeText(ms: number) {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="lib-mask" @pointerdown.self="emit('close')">
      <div class="lib">
        <header class="lib-head">
          <div class="lib-tabs">
            <button
              class="lib-tab"
              :class="{ on: tab === 'attach' }"
              @click="tab = 'attach'"
            >
              附件库
            </button>
            <button class="lib-tab" :class="{ on: tab === 'trash' }" @click="tab = 'trash'">
              回收站
            </button>
          </div>
          <button class="lib-x" title="关闭 (Esc)" @click="emit('close')">
            <X :size="14" :stroke-width="2.1" />
          </button>
        </header>

        <div class="lib-body">
          <div v-if="!root" class="lib-empty">先打开一个笔记目录</div>

          <template v-else-if="tab === 'attach'">
            <div v-if="loading" class="lib-empty">读取中…</div>
            <div v-else-if="attach.length === 0" class="lib-empty">
              还没有附件。用工具栏的「插入图片或视频」添加，文件会存到工作区的
              <code>attachments/</code> 目录。
            </div>
            <div v-else class="lib-grid">
              <div v-for="a in attach" :key="a.rel" class="lib-card">
                <div class="lib-thumb">
                  <img v-if="!a.isVideo && a.url" :src="a.url" :alt="a.name" loading="lazy" />
                  <video v-else-if="a.isVideo && a.url" :src="a.url" muted preload="metadata" />
                  <ImageIcon v-else :size="18" :stroke-width="1.7" />
                  <span v-if="a.isVideo" class="lib-badge">
                    <Video :size="10" :stroke-width="2" />
                  </span>
                </div>
                <div class="lib-name" :title="a.name">{{ a.name }}</div>
                <div class="lib-sub">{{ sizeText(a.size) }}</div>
                <div class="lib-acts">
                  <button class="lib-act" title="插入到当前笔记" @click="insert(a)">插入</button>
                  <button class="lib-act danger" title="删除文件" @click="removeAttach(a)">
                    <Trash2 :size="12" :stroke-width="2" />
                  </button>
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <div v-if="loading" class="lib-empty">读取中…</div>
            <div v-else-if="trash.length === 0" class="lib-empty">回收站是空的</div>
            <template v-else>
              <div class="lib-list">
                <div v-for="t in trash" :key="t.key" class="lib-row">
                  <FileText class="lib-row-ico" :size="15" :stroke-width="1.8" />
                  <span class="lib-row-main">
                    <span class="lib-row-name">{{ t.name }}</span>
                    <span class="lib-row-sub">{{ t.rel }} · {{ timeText(t.deletedAt) }}</span>
                  </span>
                  <button class="lib-act" title="恢复到原位置" @click="restore(t)">
                    <RotateCcw :size="12" :stroke-width="2" />
                  </button>
                  <button class="lib-act danger" title="彻底删除" @click="purge(t)">
                    <Trash2 :size="12" :stroke-width="2" />
                  </button>
                </div>
              </div>
              <div class="lib-foot">
                <button class="lib-danger-btn" @click="emptyTrash">清空回收站</button>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.lib-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 16px;
  background: var(--n-mask);
}

.lib {
  width: 640px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  max-height: 76vh;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-raised);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
}

.lib-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 10px 9px 12px;
  border-bottom: 1px solid var(--n-line);
}
.lib-tabs {
  display: flex;
  gap: 2px;
}
.lib-tab {
  padding: 5px 11px;
  border-radius: var(--n-r-md);
  font-size: 12.5px;
  color: var(--n-fg-dim);
}
.lib-tab:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}
.lib-tab.on {
  background: var(--n-accent-soft);
  color: var(--n-accent);
  font-weight: 600;
}
.lib-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}
.lib-x:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}

.lib-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}

.lib-empty {
  padding: 40px 20px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--n-fg-faint);
}
.lib-empty code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--n-code-bg);
  font-family: var(--n-font-mono);
  font-size: 11.5px;
}

/* 附件：卡片网格 */
.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 11px;
}
.lib-card {
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  overflow: hidden;
}
.lib-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 92px;
  background: var(--n-sunken);
  color: var(--n-fg-faint);
  overflow: hidden;
}
.lib-thumb img,
.lib-thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.lib-badge {
  position: absolute;
  left: 6px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  padding: 2px 5px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.lib-name {
  padding: 7px 9px 2px;
  font-size: 12px;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-sub {
  padding: 0 9px 7px;
  font-size: 10.5px;
  color: var(--n-fg-faint);
}
.lib-acts {
  display: flex;
  gap: 4px;
  padding: 0 7px 7px;
}
.lib-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-sm);
  font-size: 11.5px;
  color: var(--n-fg-dim);
  flex: 1;
}
.lib-act:hover {
  background: var(--n-accent-soft);
  border-color: var(--n-accent);
  color: var(--n-accent);
}
.lib-act.danger {
  flex: none;
  width: 30px;
  padding: 0;
}
.lib-act.danger:hover {
  background: var(--n-danger-soft);
  border-color: var(--n-danger);
  color: var(--n-danger);
}

/* 回收站：行列表 */
.lib-list {
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  overflow: hidden;
}
.lib-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 11px;
  text-align: left;
}
.lib-row + .lib-row {
  border-top: 1px solid var(--n-line);
}
.lib-row-ico {
  color: var(--n-fg-faint);
  flex: none;
}
.lib-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lib-row-name {
  font-size: 12.5px;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-row-sub {
  font-size: 10.5px;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-row .lib-act {
  flex: none;
  width: auto;
  min-width: 30px;
}
.lib-foot {
  display: flex;
  justify-content: flex-end;
  padding-top: 11px;
}
.lib-danger-btn {
  padding: 6px 13px;
  border: 1px solid var(--n-danger);
  border-radius: var(--n-r-md);
  font-size: 12px;
  color: var(--n-danger);
}
.lib-danger-btn:hover {
  background: var(--n-danger-soft);
}
</style>
