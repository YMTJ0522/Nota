<script setup lang="ts">
/**
 * 中间那一列的「附件库」视图。
 *
 * 工作区 `attachments/` 下的图片与视频，挑一个插进正在写的笔记。
 *
 * 它原来是一个独立弹窗，现在住进了中间那一列 —— 用户的话是「别单独做一个窗口了，
 * 就在那个栏上显示」。这样插图的动作可以眼不离正文：左边挑素材、右边就是
 * 光标等着插进去的地方，不用先关掉一层遮罩再找光标。
 *
 * 插入不走 props 层层传，而是抛一个 nota:insert 事件——
 * 附件库可能从侧栏被唤起，让它直接认识编辑器会把两边焊死。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Image as ImageIcon, Paperclip, RefreshCw, Trash2, Video } from 'lucide-vue-next'
import { store } from '@/store'
import { escapeLinkDestination } from '@/editor/markdown-commands'

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

// 换工作区时重取；这一列在别的视图待着时不做无用功
watch(
  () => [root.value, store.state.columnView] as const,
  ([r, view]) => {
    if (r && view === 'attach') void load()
    else if (!r) items.value = []
  },
  { immediate: true },
)

/** 别处动了附件（上传完新图、回收站清空），侧栏会抛这个事件让计数跟着变 */
function onLibraryChanged() {
  if (store.state.columnView === 'attach') void load()
}

onMounted(() => window.addEventListener('nota:library-changed', onLibraryChanged))
onBeforeUnmount(() => window.removeEventListener('nota:library-changed', onLibraryChanged))

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
  // 附件数变了，侧栏那个小数字要跟着走
  window.dispatchEvent(new CustomEvent('nota:library-changed'))
}

function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

defineExpose({ count: computed(() => items.value.length), reload: load })
</script>

<template>
  <div class="av">
    <header class="pn-head">
      <span class="pn-ico"><Paperclip :size="14" :stroke-width="1.9" /></span>
      <span class="pn-title">附件库</span>
      <span class="pn-sub">{{ root ? `${items.length} 个文件` : '' }}</span>
      <button class="pn-x" data-tip="重新读取" title="重新读取" @click="load()">
        <RefreshCw :size="13" :stroke-width="1.9" />
      </button>
    </header>

    <div class="pn-body">
      <div v-if="!root" class="pn-empty">先打开一个笔记目录</div>
      <div v-else-if="loading" class="pn-empty">读取中…</div>
      <div v-else-if="items.length === 0" class="pn-empty">
        还没有附件。用工具栏的「插入图片或视频」添加，文件会存到工作区的
        <code>attachments/</code> 目录。
      </div>
      <div v-else class="av-grid">
        <div v-for="a in items" :key="a.rel" class="av-card">
          <div class="av-thumb">
            <img v-if="!a.isVideo && a.url" :src="a.url" :alt="a.name" loading="lazy" />
            <video v-else-if="a.isVideo && a.url" :src="a.url" muted preload="metadata" />
            <ImageIcon v-else :size="18" :stroke-width="1.7" />
            <span v-if="a.isVideo" class="av-badge">
              <Video :size="10" :stroke-width="2" />
            </span>
          </div>
          <div class="av-name" :title="a.name">{{ a.name }}</div>
          <div class="av-sub">{{ sizeText(a.size) }}</div>
          <div class="av-acts">
            <button class="pn-act av-insert" title="插入到当前笔记" @click="insert(a)">
              插入
            </button>
            <button class="pn-act danger av-del" title="删除文件" @click="remove(a)">
              <Trash2 :size="12" :stroke-width="2" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.av {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* 一格放不下就自己换行：栏宽可以拖，网格得跟得上 */
.av-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 10px;
}

.av-card {
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  overflow: hidden;
}

.av-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 84px;
  background: var(--n-sunken);
  color: var(--n-fg-faint);
  overflow: hidden;
}

.av-thumb svg {
  fill: none;
  stroke: currentColor;
}

.av-thumb img,
.av-thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.av-badge {
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

.av-badge svg {
  fill: none;
  stroke: currentColor;
}

.av-name {
  padding: 6px 8px 2px;
  font-size: 11.5px;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.av-sub {
  padding: 0 8px 6px;
  font-size: 10px;
  color: var(--n-fg-faint);
}

.av-acts {
  display: flex;
  gap: 4px;
  padding: 0 6px 6px;
}

.av-insert {
  flex: 1;
}

.av-del {
  width: 28px;
  padding: 0;
}
</style>
