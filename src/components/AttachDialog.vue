<script setup lang="ts">
/**
 * 附件库。
 *
 * 工作区 `attachments/` 下的图片与视频，挑一个插进正在写的笔记。
 *
 * 它和「回收站」是两件完全不同的事——一个挑素材、一个捞回误删的笔记，
 * 所以各占一个独立窗口，不再共用一个带页签的对话框：页签会让人
 * 以为两者是一类东西，而且每次都得先确认自己在哪一页。
 *
 * 插入不走 props 层层传，而是抛一个 nota:insert 事件——
 * 附件库可能从侧栏被唤起，让它直接认识编辑器会把两边焊死。
 */
import { computed, ref, watch } from 'vue'
import { Image as ImageIcon, Paperclip, Trash2, Video, X } from 'lucide-vue-next'
import { store } from '@/store'
import { escapeLinkDestination } from '@/editor/markdown-commands'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface Attach {
  rel: string
  name: string
  size: number
  mtime: number
  isVideo: boolean
  url?: string
}

const items = ref<Attach[]>([])
const loading = ref(false)

const root = computed(() => store.state.root ?? '')

async function load() {
  if (!root.value) {
    items.value = []
    return
  }
  loading.value = true
  try {
    const list = await window.api.attachList(root.value)
    // 缩略图要逐个换算成可加载的 URL，和预览区走同一条路
    items.value = await Promise.all(
      list.map(async (a) => ({
        ...a,
        url: (await window.api.resolveMedia(root.value, a.rel)) ?? '',
      })),
    )
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

// 打开时取一次；关着的时候不碰磁盘
watch(
  () => props.open,
  (v) => {
    if (v) void load()
  },
  { immediate: true },
)

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

function insert(a: Attach) {
  const text = a.isVideo
    ? `<video src="${a.rel}" controls></video>`
    : `![${a.name.replace(/\.[^.]+$/, '')}](${escapeLinkDestination(a.rel)})`
  window.dispatchEvent(new CustomEvent('nota:insert', { detail: text }))
  toast('已插入到当前笔记')
}

async function remove(a: Attach) {
  if (!root.value) return
  await window.api.attachDelete(root.value, a.rel)
  items.value = items.value.filter((x) => x.rel !== a.rel)
  toast(`已删除 ${a.name}`)
}

function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dlg-mask" @pointerdown.self="emit('close')">
      <div class="dlg" role="dialog" aria-modal="true" aria-label="附件库">
        <header class="dlg-head">
          <span class="dlg-head-ico"><Paperclip :size="15" :stroke-width="1.9" /></span>
          <span class="dlg-title">附件库</span>
          <span class="dlg-sub">{{ root ? `${items.length} 个文件` : '先打开一个笔记目录' }}</span>
          <button class="dlg-x" title="关闭 (Esc)" @click="emit('close')">
            <X :size="14" :stroke-width="2.1" />
          </button>
        </header>

        <div class="dlg-body">
          <div v-if="!root" class="dlg-empty">先打开一个笔记目录</div>
          <div v-else-if="loading" class="dlg-empty">读取中…</div>
          <div v-else-if="items.length === 0" class="dlg-empty">
            还没有附件。用工具栏的「插入图片或视频」添加，文件会存到工作区的
            <code>attachments/</code> 目录。
          </div>
          <div v-else class="adlg-grid">
            <div v-for="a in items" :key="a.rel" class="adlg-card">
              <div class="adlg-thumb">
                <img v-if="!a.isVideo && a.url" :src="a.url" :alt="a.name" loading="lazy" />
                <video v-else-if="a.isVideo && a.url" :src="a.url" muted preload="metadata" />
                <ImageIcon v-else :size="18" :stroke-width="1.7" />
                <span v-if="a.isVideo" class="adlg-badge">
                  <Video :size="10" :stroke-width="2" />
                </span>
              </div>
              <div class="adlg-name" :title="a.name">{{ a.name }}</div>
              <div class="adlg-sub">{{ sizeText(a.size) }}</div>
              <div class="adlg-acts">
                <button class="dlg-act adlg-insert" title="插入到当前笔记" @click="insert(a)">
                  插入
                </button>
                <button class="dlg-act danger adlg-del" title="删除文件" @click="remove(a)">
                  <Trash2 :size="12" :stroke-width="2" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.adlg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 11px;
}

.adlg-card {
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  overflow: hidden;
}

.adlg-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 92px;
  background: var(--n-sunken);
  color: var(--n-fg-faint);
  overflow: hidden;
}

.adlg-thumb svg {
  fill: none;
  stroke: currentColor;
}

.adlg-thumb img,
.adlg-thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.adlg-badge {
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

.adlg-badge svg {
  fill: none;
  stroke: currentColor;
}

.adlg-name {
  padding: 7px 9px 2px;
  font-size: 12px;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.adlg-sub {
  padding: 0 9px 7px;
  font-size: 10.5px;
  color: var(--n-fg-faint);
}

.adlg-acts {
  display: flex;
  gap: 4px;
  padding: 0 7px 7px;
}

.adlg-insert {
  flex: 1;
}

.adlg-del {
  width: 30px;
  padding: 0;
}
</style>
