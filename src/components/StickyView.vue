<script setup lang="ts">
/**
 * 中间那一列的「便签」视图。
 *
 * 便签是关在独立小窗口里的，这里是它们的账本：还开着的、已经收进抽屉的、
 * 以及存进笔记库的，都在这一屏。没有这一屏，用户按 Esc 关掉一张纸之后
 * 就再也找不回来了 —— 归档就等于丢失。
 *
 * 点一条就把它重新放到桌面上（不是在这一列里展开编辑）：便签的用法是
 * 「贴在屏幕角落随手写」，在窄栏里改字反而不顺手。
 *
 * 这一屏的顶栏没有按钮 —— 「新建 / 收起全部」在资料栏右上角，
 * 和笔记页的「新建 / 导入」同一个位置（见 SideColumn）。以前那一条
 * 实心彩按钮横在列表上方，这一列别处都没有那种条，看着像外来零件。
 *
 * 管理动作和笔记那一边对齐：右键出菜单（打开 / 重命名 / 标记 / 复制 /
 * 存为笔记 / 定位 / 删除），顶上一条筛选框，标签点一下就筛。
 *
 * 两层显示上的讲究：
 *  · 一条便签上真正属于「内容」的是标题、正文、标签、图标。状态（收起没、
 *    存没存过）是附属信息，用一枚很小的记号带过，不再各占一枚胶囊 ——
 *    两枚 chip 叠在一起，扫列表时它们比标题还显眼，那是反的。
 *  · 清抽屉这件事一个人干十几遍就要疯，所以有选择模式：底栏换成一条
 *    操作条，存为笔记 / 收起 / 加标签 / 删除一次作用于一批。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ChevronDown,
  ChevronsDown,
  FolderOpen,
  Hash,
  NotebookPen,
  Search,
  StickyNote,
  Trash2,
  Check,
  X,
} from 'lucide-vue-next'
import { store, touchStickies } from '@/store'
import { dropFromStickies, stickyStore } from '@/store/stickies'
import BrandGlyph from '@/components/BrandGlyph.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import PromptDialog from '@/components/PromptDialog.vue'
import StickyContextMenu from '@/components/StickyContextMenu.vue'
import StickyMarkDialog from '@/components/StickyMarkDialog.vue'
import { paperOf } from '@/sticky/colors'
import { relTime } from '@/sticky/format'

/* 便签数据只有一份（见 store/stickies.ts）。这里读的是共享对象本身，
   不是自己那份快照 —— 所以右边那面墙改了什么，这一列不用重新拉就已经变了。 */
const items = computed(() => stickyStore.items)
const loading = computed(() => stickyStore.loading)
/** 已归档的默认收起来：桌面上真正在用的一般就那么几张，历史不该占满一屏 */
const showArchived = ref(false)
/** 待确认删除的那一张。null = 弹窗关着 */
const delTarget = ref<StickyItem | null>(null)
/** 一次问一批时挂在这里（批量删除和单张共用同一个弹窗） */
const delBatch = ref<StickyItem[]>([])

/** 筛选词。便签的正文不长，全在内存里筛，不额外读盘 */
const q = ref('')
/** 点标签筛。null = 不筛 */
const tagFilter = ref<string | null>(null)

const menu = ref<{
  x: number
  y: number
  id: string
  saved: boolean
  color?: string
} | null>(null)
const actId = ref('')
const renameOpen = ref(false)
const markOpen = ref(false)
/** 标记弹窗是不是「多选批量」那一次：只开标签页 */
const markBatch = ref(false)

/* ── 选择模式 ──
   不做「Ctrl 点选」那套隐式交互：便签这一列点一下是「放到桌面上」，是主要
   动作，抢它的修饰键会让人先试错再学会。改成底栏一颗显式的「选择」，
   进去以后点击才是勾选 —— 两种语义不打架。 */
const selecting = ref(false)
const selected = ref<string[]>([])
/** Shift 连选的头。在勾选状态之间划一段用 */
const anchor = ref<string | null>(null)
/** 批量删除的二次确认（一次问一批，不是逐条问） */

const openList = computed(() => items.value.filter((s) => !s.closedAt))
const archivedList = computed(() => items.value.filter((s) => s.closedAt))

/** 所有便签上用过的标签，按用得多的排前面 */
const allTags = computed(() => {
  const n = new Map<string, number>()
  for (const s of items.value) for (const t of s.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1)
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([name, count]) => ({ name, count }))
})

/** 标记弹窗的候选：已经有标签的那些，一点就加，免得同义词越攒越多 */
const knownTags = computed(() => allTags.value)

/* 标签行右边还有没有东西没露出来 —— 有就渐隐右边缘，而不是硬切半个字 */
const tagsEl = ref<HTMLElement | null>(null)
const tagsMore = ref(false)
function checkTagsMore() {
  const el = tagsEl.value
  if (!el) return
  tagsMore.value = el.scrollWidth - el.clientWidth - el.scrollLeft > 2
}
watch(
  () => allTags.value.length,
  async () => {
    await nextTick()
    checkTagsMore()
  },
)

const actItem = computed(() => items.value.find((s) => s.id === actId.value))

const visible = computed(() => {
  const kw = q.value.trim().toLowerCase()
  let list = showArchived.value ? items.value : openList.value
  if (tagFilter.value) list = list.filter((s) => s.tags?.includes(tagFilter.value!))
  if (kw) {
    list = list.filter(
      (s) =>
        s.title.toLowerCase().includes(kw) ||
        s.preview.toLowerCase().includes(kw) ||
        (s.tags ?? []).some((t) => t.toLowerCase().includes(kw)),
    )
  }
  return list
})

const filtering = computed(() => !!q.value.trim() || !!tagFilter.value)

/**
 * 抽屉展开以后，「桌面上的」和「已收起的」会混在同一列里。
 *
 * 以前是给每条挂一枚「已收起」的小箭头 —— 可抽屉一展开，那一列全都是
 * 收起的，这枚记号恒为真，等于没有信息，只留下满屏的重复符号。改成
 * 分两段排，只在两段都有内容时才加小标题（只有一段的时候加标题是废话）。
 */
const groups = computed(() => {
  const list = visible.value
  const open = list.filter((s) => !s.closedAt)
  const closed = list.filter((s) => s.closedAt)
  const both = open.length > 0 && closed.length > 0
  const out: { key: string; label: string; items: StickyItem[] }[] = []
  if (open.length) out.push({ key: 'open', label: both ? '在桌面上' : '', items: open })
  if (closed.length) out.push({ key: 'closed', label: both ? '已收起' : '', items: closed })
  return out
})

/** Shift 连选要的是「在当前可见顺序里的第几个」，分组打散之后得回原表找 */
function idxOf(s: StickyItem): number {
  return visible.value.indexOf(s)
}

/** 选中的这批（按 visible 的顺序，删/存的时候看着像从上到下走过） */
const selItems = computed(() => visible.value.filter((s) => selected.value.includes(s.id)))
const allSel = computed(
  () => visible.value.length > 0 && visible.value.every((s) => selected.value.includes(s.id)),
)

/**
 * 选中集要跟着数据走：某条被删掉（可能是右边的墙删的）之后，
 * 它不能继续算在「已选 3 张」里 —— 底栏会显示三张、列表上只剩两张。
 *
 * 这是**这一列自己的**显示状态，不是数据同步，所以留在这儿而不是共享模块里。
 */
watch(
  () => stickyStore.items,
  () => {
    const alive = new Set(stickyStore.items.map((s) => s.id))
    selected.value = selected.value.filter((id) => alive.has(id))
    void nextTick(checkTagsMore)
  },
)

watch(
  () => store.state.columnView,
  (v) => {
    if (v !== 'stickies') exitSelect()
  },
)


/* 右边那面墙上的「选择这张…」要把用户送回这一列来勾选，
   两条路由同一个事件接上，比把选择状态提到 store 里轻 */
function onSelectReq(e: Event) {
  const id = String((e as CustomEvent<string>).detail ?? '')
  if (id) enterSelect(id)
}

onMounted(() => {
  window.addEventListener('nota:sticky-select', onSelectReq)
  window.addEventListener('resize', checkTagsMore)
  void nextTick(checkTagsMore)
})

onBeforeUnmount(() => {
  window.removeEventListener('nota:sticky-select', onSelectReq)
  window.removeEventListener('resize', checkTagsMore)
})

/** 时间只做粗粒度：便签没人关心「3 分钟前」还是「4 分钟前」 */
function when(ts: number): string {
  return relTime(ts)
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

/** 带一颗「撤销」的提示。存为笔记这种替用户做主的动作，必须留一条回头路 */
function toastUndo(text: string, run: () => void) {
  window.dispatchEvent(
    new CustomEvent('nota:toast', { detail: { text, action: { label: '撤销', run } } }),
  )
}

async function open(s: StickyItem) {
  const ok = await window.api.stickyOpen(s.id)
  if (!ok) toast('开不出来了，先关掉几张别的便签')
  else touchStickies()
}

/**
 * 删除走和笔记一样的一道确认窗口。
 *
 * 原来是「点一下变红、再点才真删」，理由是这个窄栏里弹窗太重。但两段式
 * 只防手滑、不解释后果：删完之后这张纸去哪了、能不能回，用户是不知道的。
 * 笔记那边一直是弹窗 + 回收站，同一件事在两个地方长得不一样，学两遍。
 */
function remove(s: StickyItem) {
  delBatch.value = []
  delTarget.value = s
}

/** 批量删除也走同一个弹窗，一次问一批 */
function batchDelete() {
  const ids = selItems.value.map((s) => s.id)
  if (!ids.length) return
  delTarget.value = null
  delBatch.value = selItems.value.slice()
  void ids
}

async function commitRemove() {
  const batch = delBatch.value
  const one = delTarget.value
  delTarget.value = null
  delBatch.value = []
  if (!batch.length && !one) return

  const ids = batch.length ? batch.map((s) => s.id) : [one!.id]
  if (batch.length) {
    await window.api.stickyDeleteMany(ids)
    exitSelect()
  } else {
    await window.api.stickyDelete(one!.id)
  }
  dropFromStickies(ids)
  touchStickies()
  toast(ids.length > 1 ? `已把 ${ids.length} 张便签移入回收站` : '便签已移入回收站')
}

/** 弹窗标题与正文：单张说名字，多张说数量 */
const delTitle = computed(() =>
  delBatch.value.length > 1 ? `删除这 ${delBatch.value.length} 张便签？` : '删除这张便签？',
)
const delMessage = computed(() => {
  if (delBatch.value.length > 1) return '它们会被移入回收站，之后还能恢复。'
  const s = delTarget.value
  const name = s ? s.title || s.preview || '这张便签' : ''
  return `《${name}》会被移入回收站，之后还能恢复。`
})

async function reveal(id?: string) {
  // 没给 id 就是「打开便签文件夹」；给了就是定位那一个文件
  if (!id) {
    await window.api.revealStickies()
    return
  }
  const ok = await window.api.stickyReveal(id)
  if (!ok) toast('这张便签还没写过字，磁盘上还没有文件')
}

/* ── 选择模式 ── */
function enterSelect(seed?: string) {
  selecting.value = true
  selected.value = seed ? [seed] : []
  anchor.value = seed ?? null
}

function exitSelect() {
  selecting.value = false
  selected.value = []
  anchor.value = null
}

function isSel(id: string) {
  return selected.value.includes(id)
}

function toggleSel(id: string) {
  selected.value = isSel(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id]
  anchor.value = id
}

/** 点条目：没在选择模式就是「打开」，在选择模式就是勾一个（Shift 划一段） */
function onItem(e: MouseEvent, s: StickyItem, idx: number) {
  if (!selecting.value) {
    void open(s)
    return
  }
  if (e.shiftKey && anchor.value) {
    const list = visible.value
    const a = list.findIndex((x) => x.id === anchor.value)
    if (a >= 0) {
      const [lo, hi] = a < idx ? [a, idx] : [idx, a]
      const span = list.slice(lo, hi + 1).map((x) => x.id)
      selected.value = [...new Set([...selected.value, ...span])]
      return
    }
  }
  toggleSel(s.id)
}

function toggleAll() {
  selected.value = allSel.value ? [] : visible.value.map((s) => s.id)
}

/* ── 批量动作 ── */

async function batchSave() {
  const ids = selItems.value.map((s) => s.id)
  if (!ids.length) return
  let first = ''
  const done: string[] = []
  for (const id of ids) {
    const r = await window.api.stickySaveToVault(id)
    if (r.ok) {
      done.push(id)
      if (!first && r.rel) first = r.rel
    }
  }
  exitSelect()
  touchStickies()
  if (!done.length) return toast('一张都没存进去，先打开看看是不是空的')
  const text =
    done.length === 1 ? `已存入 ${first}` : `已存入 ${done.length} 张，收进抽屉了`
  toastUndo(text, () => void undoArchive(done))
}

/**
 * 撤销「存为笔记」＝把纸放回桌面。
 *
 * 只把 closedAt 抹掉是不够的：归档的定义是「窗口关了」，光抹字段会让列表
 * 显示成「在桌面上」而屏幕上什么都没有，点一下才弹出来 —— 状态和事实对不上
 * 是最难查的那种错。所以这里连窗口一起开回来。开不出来（撞上同时 12 张的
 * 上限）就直说。
 */
async function undoArchive(ids: string[]) {
  await window.api.stickyBatchPatch(ids, { closedAt: null })
  let failed = 0
  for (const id of ids) {
    const ok = await window.api.stickyOpen(id)
    if (!ok) failed++
  }
  touchStickies()
  if (failed) toast(`已经放回列表，但有 ${failed} 张没能弹到桌面上（便签开太多了）`)
}

async function batchArchive() {
  const ids = selItems.value.map((s) => s.id)
  if (!ids.length) return
  // 开着的走 closeOne（关窗 → finishSticky → 写 closedAt），没开着的本来就是归档态
  for (const id of ids) await window.api.stickyCloseOne(id)
  exitSelect()
  touchStickies()
  toast(`已收起 ${ids.length} 张`)
}



function openBatchTag() {
  if (!selItems.value.length) return
  markBatch.value = true
  markOpen.value = true
}

/* ── 右键菜单 ── */
function onMenu(e: MouseEvent, s: StickyItem) {
  e.preventDefault()
  menu.value = { x: e.clientX, y: e.clientY, id: s.id, saved: !!s.savedTo, color: s.color }
}

function closeMenu() {
  menu.value = null
}

/** 右键换纸色。窗口正开着也没关系：主进程会顺手把新纸色推给那张纸 */
async function onMenuColor(id: string, key: string) {
  menu.value = null
  await window.api.stickyPatch(id, { color: key })
  touchStickies()
}

/**
 * 菜单动作一律**自带 id**：`@mark="onMenuMark"` 收的是菜单报出来的那一张。
 *
 * 以前每个动作第一句都是 `take()` —— 回头去读 `menu.value?.id`。可菜单
 * 收起（`@close` 把 menu 置 null）跟动作是同一轮事件里发生的，谁先谁后
 * 取决于点击落在哪个节点上。抢在前面时 id 就是空的，动作静默变成空操作：
 * 「标记里设完图标、点完成，右边没变」正是这么来的 —— 写盘那一步根本没发生。
 * 菜单是界面状态，动作要的参数不该从界面状态里反查。
 */
function onMenuOpen(id: string) {
  const s = items.value.find((x) => x.id === id)
  if (s) void open(s)
}

function onMenuRename(id: string) {
  actId.value = id
  markBatch.value = false
  renameOpen.value = true
}

function onMenuMark(id: string) {
  actId.value = id
  markBatch.value = false
  markOpen.value = true
}

function onMenuSelect(id: string) {
  if (id) enterSelect(id)
}

async function onMenuCopy(id: string) {
  if (!id) return
  const text = await window.api.stickyText(id)
  if (!text.trim()) return toast('这张便签还是空的')
  try {
    await navigator.clipboard.writeText(text)
    toast('正文已复制')
  } catch {
    toast('剪贴板不可用')
  }
}

/**
 * 存为笔记。**存完这张纸会自己收进抽屉**（主进程那边默认归档），
 * 因为搬进库本来就是它的终点；想留着继续写就点提示上那颗「撤销」。
 * 以前只补一枚「已存入」标就走人，桌面上越堆越多已经搬过家的空壳。
 */
async function onMenuSave(id: string) {
  if (!id) return
  const r = await window.api.stickySaveToVault(id)
  if (!r.ok) return toast(r.error ?? '存不进去')
  touchStickies()
  toastUndo(`已存入 ${r.rel}`, () => void undoArchive([id]))
}

function onMenuReveal(id: string) {
  if (id) void reveal(id)
}

async function onMenuRemove(id: string) {
  const s = items.value.find((x) => x.id === id)
  if (s) await remove(s)
}

/* ── 重命名 / 标记 ── */
async function commitRename(v: string) {
  renameOpen.value = false
  const id = actId.value
  if (!id || !v.trim()) return
  const r = await window.api.stickyRename(id, v)
  if (!r.ok) return toast(r.error ?? '改不了名字')
  touchStickies()
}

/** 图标改动即时生效：关掉弹窗不该把点过的选择弄丢 */
async function pickIcon(ic: { kind: 'brand' | 'emoji'; id: string } | null) {
  const id = actId.value
  if (!id) return
  await window.api.stickyPatch(id, { icon: ic })
  /* 写完发信号，两边一起重拉（这一列和右边那面墙各捏着一份快照）。
     就地改手里的对象不行：这期间任何一次 reloadStickies() 都会把它换成新数组，
     改中的是一张没人再渲染的旧卡片 —— 就是「点了没反应」。 */
  touchStickies()
}

/**
 * 标签改动。批量模式下作用于选中那一批：取这批的并集再统一写下去 ——
 * 每张纸上「原本有什么」各不相同，直接用弹窗里显示的某个基准值会悄悄
 * 抹掉别的纸上已有的标签。
 */
async function setTags(tags: string[]) {
  if (markBatch.value) {
    const list = selItems.value
    if (!list.length) return
    // 弹窗里显示的是并集；用户去掉某个标签的意思是「这批都不要它」
    const drop = new Set<string>()
    for (const s of list) for (const t of s.tags ?? []) if (!tags.includes(t)) drop.add(t)
    const add = new Set<string>()
    for (const t of tags) if (!list.every((s) => s.tags?.includes(t))) add.add(t)
    if (!add.size && !drop.size) return
    for (const s of list) {
      const next = [...new Set([...(s.tags ?? []).filter((t) => !drop.has(t)), ...add])]
      await window.api.stickyPatch(s.id, { tags: next })
      s.tags = next
    }
    /* 批量也可能是从墙上进来的（墙上的「选择这张…」会把用户送回这一列），
       墙那份快照同样得刷 —— 所以信号统一在最后发一次 */
    touchStickies()
    return
  }
  const id = actId.value
  if (!id) return
  await window.api.stickyPatch(id, { tags })
  /* 同 pickIcon：发信号，让墙和这一列都重拉。批量那条路改的是 `selItems`，
     它同样是快照 —— 只改它，下一轮 load 就把它冲掉了 */
  touchStickies()
  // 正在按某个标签筛，而它刚被从最后一张便签上去掉 —— 筛出来的空列表会让人以为丢了东西
  if (tagFilter.value && !items.value.some((x) => x.tags?.includes(tagFilter.value!)))
    tagFilter.value = null
}

function toggleTag(name: string) {
  tagFilter.value = tagFilter.value === name ? null : name
}

/** 一条纸色小圆点：没打标记的便签靠它认「和桌面上那张是一张纸」 */
function dotStyle(s: StickyItem) {
  const p = paperOf(s.color)
  return { background: p.bg, boxShadow: `inset 0 0 0 1px ${p.dim}` }
}

/** 批量弹窗里那批标签的并集 */
const batchTags = computed(() => {
  const n = new Set<string>()
  for (const s of selItems.value) for (const t of s.tags ?? []) n.add(t)
  return [...n]
})
</script>

<template>
  <section class="sv">
    <!-- 顶上一条筛选，和笔记页同一个位置、同一种长相 -->
    <div class="sv-search">
      <Search class="sv-search-ico" :size="13" :stroke-width="2" />
      <input
        v-model="q"
        class="sv-search-input"
        type="text"
        placeholder="在便签中筛选…"
        spellcheck="false"
        @keydown.esc="q = ''"
      />
      <button v-if="q" class="sv-search-x" title="清除" @click="q = ''">
        <X :size="12" :stroke-width="2.2" />
      </button>
    </div>

    <!-- 标签行只在真的打过标签时出现：一张标签都没有的时候摆一排空的筛选器，
         等于在教人「这里有个你还没用上的功能」 -->
    <div
      v-if="allTags.length"
      ref="tagsEl"
      class="sv-tags"
      :class="{ more: tagsMore }"
      @scroll.passive="checkTagsMore"
    >
      <button
        v-for="t in allTags"
        :key="t.name"
        class="sv-tag"
        :class="{ on: tagFilter === t.name }"
        :title="`只看带「${t.name}」的便签`"
        @click="toggleTag(t.name)"
      >
        <Hash :size="10" :stroke-width="2.4" />{{ t.name }}
        <span class="sv-tag-n">{{ t.count }}</span>
      </button>
    </div>

    <div class="sv-list">
      <template v-for="g in groups" :key="g.key">
        <div v-if="g.label" class="sv-group">{{ g.label }}</div>
        <div
          v-for="s in g.items"
          :key="s.id"
          class="sv-item"
          :class="{ sel: isSel(s.id), picking: selecting, menu: menu?.id === s.id }"
          role="button"
          tabindex="0"
          :title="s.preview || s.title"
          @click="onItem($event, s, idxOf(s))"
          @keydown.enter.prevent="selecting ? toggleSel(s.id) : open(s)"
          @contextmenu.prevent="onMenu($event, s)"
        >
          <!-- 勾选圈只在选择模式里出现，就地顶掉原来那枚图标：位置不变，
               眼睛不用重新找一行 -->
          <span v-if="selecting" class="sv-cb" :class="{ on: isSel(s.id) }">
            <Check v-if="isSel(s.id)" :size="9" :stroke-width="3.6" />
          </span>
          <span v-else class="sv-ico">
            <BrandGlyph v-if="s.icon?.kind === 'brand'" :id="s.icon.id" :size="16" />
            <span v-else-if="s.icon?.kind === 'emoji'" class="sv-emoji">{{ s.icon.id }}</span>
            <span v-else class="sv-dot" :style="dotStyle(s)" />
          </span>

          <span class="sv-main">
            <span class="sv-head">
              <span class="sv-title">{{ s.title }}</span>
              <!-- 状态用一枚记号带过：已存入是「有去处」，不占一行 -->
              <Check v-if="s.savedTo" class="sv-saved" :size="11" :stroke-width="2.8" />
              <span class="sv-time">{{ when(s.updatedAt || s.createdAt) }}</span>
            </span>
            <span v-if="s.preview" class="sv-prev">{{ s.preview }}</span>
            <!-- 标签放在正文下面而不是顶上的筛选行里：打过的标看不见，等于没打 -->
            <span v-if="s.tags?.length" class="sv-item-tags">
              <button
                v-for="t in s.tags.slice(0, 3)"
                :key="t"
                class="sv-item-tag"
                :title="`只看带「${t}」的便签`"
                @click.stop="toggleTag(t)"
              >
                #{{ t }}
              </button>
              <span v-if="s.tags.length > 3" class="sv-item-tag more" :title="s.tags.join(' ')"
                >+{{ s.tags.length - 3 }}</span
              >
            </span>
          </span>

          <span v-if="!selecting" class="sv-del" title="删除" @click.stop="remove(s)">
            <Trash2 :size="12" :stroke-width="2" />
          </span>
        </div>
      </template>

      <!-- 空态分两种：一张都没有 vs 筛掉了。混着说会让人以为便签丢了 -->
      <div v-if="!loading && visible.length === 0" class="sv-empty">
        <StickyNote :size="22" :stroke-width="1.5" />
        <template v-if="filtering">
          <p>没有匹配的便签</p>
          <button class="sv-clear" @click="q = ''; tagFilter = null">清除筛选</button>
        </template>
        <template v-else-if="showArchived">
          <p>还没有便签</p>
        </template>
        <template v-else-if="archivedList.length">
          <p>桌面上的便签都收起来了</p>
          <p class="sub">点底下的「已收起 {{ archivedList.length }} 张」能看到它们</p>
        </template>
        <template v-else>
          <p>还没有便签</p>
          <p class="sub">
            任何时候按 <kbd>Alt</kbd>+<kbd>N</kbd> 记一张，写完可以一键存成笔记
          </p>
        </template>
      </div>
    </div>

    <!-- 底下一条：左边是归档的抽屉，右边是文件夹。
         这两件事都跟「列表里有什么」无关，所以压在最下面，
         不占列表的注意力 -->
    <footer v-if="!selecting" class="sv-foot">
      <!-- 归档抽屉的开关。文案固定写「已收起 N 张」——展开时改成
           「只看开着的」会在开着的为 0 时变成一个「只看 0 张」的废按钮 -->
      <button
        v-if="archivedList.length"
        class="sv-more"
        :class="{ open: showArchived }"
        :title="showArchived ? '折叠已收起' : '展开已收起'"
        @click="showArchived = !showArchived"
      >
        <ChevronDown :size="12" :stroke-width="2.2" />
        <span>已收起 {{ archivedList.length }} 张</span>
      </button>
      <span v-else class="sv-count">
        {{ openList.length ? `${openList.length} 张在桌面上` : '桌面上没有便签' }}
      </span>
      <button v-if="items.length" class="sv-icon-btn" title="批量选择" @click="enterSelect()">
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
          <path d="M8 12.3l2.7 2.7L16 9.5" />
        </svg>
      </button>
      <button class="sv-icon-btn" title="打开便签文件夹" @click="reveal()">
        <FolderOpen :size="13" :stroke-width="1.9" />
      </button>
    </footer>

    <!-- 选择模式下，底栏整条换成批量操作。宽度只有一列，所以全是图标 + 悬停说明，
         左边留一句「几张」，右边留一个「完成」 -->
    <footer v-else class="sv-foot picking">
      <span class="sv-sel-n">{{ selected.length }} 张</span>
      <button class="sv-sel-text" @click="toggleAll">{{ allSel ? '取消' : '全选' }}</button>
      <span class="sv-sel-sep" />
      <button
        class="sv-icon-btn"
        :disabled="!selected.length"
        title="存为笔记"
        @click="batchSave"
      >
        <NotebookPen :size="13" :stroke-width="1.9" />
      </button>
      <button
        class="sv-icon-btn"
        :disabled="!selected.length"
        title="收起到抽屉"
        @click="batchArchive"
      >
        <ChevronsDown :size="13" :stroke-width="2" />
      </button>
      <button
        class="sv-icon-btn"
        :disabled="!selected.length"
        title="加标签"
        @click="openBatchTag"
      >
        <Hash :size="13" :stroke-width="2.1" />
      </button>
      <button
        class="sv-icon-btn danger"
        :disabled="!selected.length"
        title="删除"
        @click="batchDelete"
      >
        <Trash2 :size="13" :stroke-width="1.9" />
      </button>
      <span class="sv-sel-sep" />
      <button class="sv-sel-text" title="退出选择" @click="exitSelect">完成</button>
    </footer>

    <StickyContextMenu
      :target="menu"
      @close="closeMenu"
      @open="onMenuOpen"
      @rename="onMenuRename"
      @mark="onMenuMark"
      @select="onMenuSelect"
      @copy="onMenuCopy"
      @save="onMenuSave"
      @reveal="onMenuReveal"
      @remove="onMenuRemove"
      @color="onMenuColor"
    />

    <PromptDialog
      :open="renameOpen"
      title="重命名"
      label="标题"
      :initial="actItem?.title ?? ''"
      placeholder="输入新的标题"
      confirm-text="重命名"
      @confirm="commitRename"
      @cancel="renameOpen = false"
    />

    <StickyMarkDialog
      :open="markOpen"
      :title="markBatch ? `${selItems.length} 张便签` : (actItem?.title ?? '')"
      :icon="markBatch ? null : (actItem?.icon ?? null)"
      :tags="markBatch ? batchTags : (actItem?.tags ?? [])"
      :known="knownTags"
      :tags-only="markBatch"
      @close="markOpen = false"
      @pick-icon="pickIcon"
      @set-tags="setTags"
    />

    <!-- 和笔记页同一个弹窗、同一句说法：删除是「移入回收站」，不是抹掉 -->
    <ConfirmDialog
      :open="!!delTarget || delBatch.length > 0"
      :title="delTitle"
      :message="delMessage"
      confirm-text="确认删除"
      danger
      @confirm="commitRemove"
      @cancel="((delTarget = null), (delBatch = []))"
    />
  </section>
</template>

<style scoped>
.sv {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 和笔记页的筛选框同一套尺寸与配色（见 NoteListView 的 .nl-search）：
   两屏挨着看，一条 28 一条 32 会显得这一屏是拼上去的 */
.sv-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin: 8px 8px 2px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--n-line) 54%, transparent);
  background: color-mix(in oklab, var(--n-raised) 42%, var(--n-sunken));
  transition:
    border-color var(--n-dur) var(--n-ease),
    background-color var(--n-dur) var(--n-ease);
}
.sv-search:hover,
.sv-search:focus-within {
  border-color: color-mix(in oklab, var(--n-line) 88%, transparent);
  background: color-mix(in oklab, var(--n-raised) 72%, var(--n-sunken));
}
.sv-search:focus-within {
  border-color: var(--n-accent);
}

.sv-search-ico {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-fg-faint);
}

.sv-search-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  background: none;
  border: none;
  outline: none;
}
.sv-search-input::placeholder {
  color: color-mix(in oklab, var(--n-fg-faint) 82%, transparent);
}

.sv-search-x {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--n-fg-faint);
}
.sv-search-x:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}
.sv-search-x svg {
  fill: none;
  stroke: currentColor;
}

/* 标签行：横向排，超了就自己滚，不换行 —— 换行会把列表顶下去一大截。
   还有得滚的时候右边缘渐隐（和图标网格底边同一个道理）：硬切一截像被裁坏了，
   淡出本身就在说「右边还有」。 */
.sv-tags {
  flex: none;
  display: flex;
  gap: 5px;
  padding: 6px 8px 2px;
  overflow-x: auto;
  scrollbar-width: none;
}
.sv-tags.more {
  mask-image: linear-gradient(to right, #000 calc(100% - 26px), transparent);
}
.sv-tags::-webkit-scrollbar {
  display: none;
}

.sv-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--n-line);
  background: var(--n-surface);
  font-size: 11px;
  color: var(--n-fg-dim);
  transition:
    background var(--n-dur) var(--n-ease),
    border-color var(--n-dur) var(--n-ease),
    color var(--n-dur) var(--n-ease);
}
.sv-tag svg {
  fill: none;
  stroke: currentColor;
  opacity: 0.7;
}
.sv-tag:hover {
  color: var(--n-fg);
  border-color: color-mix(in oklab, var(--n-line) 70%, var(--n-fg-faint));
}
.sv-tag.on {
  background: color-mix(in oklab, var(--n-accent) 14%, transparent);
  border-color: color-mix(in oklab, var(--n-accent) 45%, transparent);
  color: var(--n-accent);
}
.sv-tag-n {
  font-size: 10px;
  opacity: 0.6;
}

.sv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 6px 8px;
}

/* 一条便签：左边一枚标记（图标 / 纸色点），右边三行。
   内容用 .sv-main 包起来再 flex:1，是因为列向 flex 里长文本会把整行撑出面板
   （见项目里那条「列向 flex + align-items:flex-start」的坑） */
.sv-item {
  position: relative;
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 30px 8px 8px;
  border-radius: 8px;
  cursor: default;
  transition: background 130ms ease;
}
.sv-item:hover {
  background: var(--n-hover, var(--n-surface));
}
.sv-item:focus-visible {
  outline: 2px solid var(--n-accent);
  outline-offset: -2px;
}
/* 选择模式下整条都是勾选区，右侧不再留那颗删除键的位置 */
.sv-item.picking {
  padding-right: 8px;
}
.sv-item.sel {
  background: color-mix(in oklab, var(--n-accent) 13%, transparent);
}
.sv-item.sel:hover {
  background: color-mix(in oklab, var(--n-accent) 18%, transparent);
}
/* 右键点开菜单的那一条：整条描一圈 + 底色，让人知道菜单是在操作谁。
   以前右键下去菜单弹出来了，列表里毫无变化，鼠标一移就分不清是哪一张。 */
.sv-item.menu {
  background: color-mix(in oklab, var(--n-accent) 15%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--n-accent) 55%, transparent);
}

/* 抽屉展开后的分段标题：只在「桌面上的」和「已收起的」同时存在时才出现，
   一行小字，比给每条挂一枚状态图标安静得多 */
.sv-group {
  padding: 10px 8px 3px;
  font-size: 10.5px;
  letter-spacing: 0.05em;
  color: var(--n-fg-faint);
}
.sv-group:first-child {
  padding-top: 2px;
}

.sv-ico {
  flex: none;
  width: 18px;
  height: 16px;
  display: grid;
  place-items: center;
  margin-top: 1px;
}

/* 勾选圈：占的正是原来那枚图标的位置，选中才填实 */
.sv-cb {
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 1px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1.5px solid color-mix(in oklab, var(--n-fg-faint) 70%, transparent);
  color: #fff;
  transition:
    background 120ms ease,
    border-color 120ms ease;
}
.sv-cb.on {
  background: var(--n-accent);
  border-color: var(--n-accent);
}
.sv-cb svg {
  fill: none;
  stroke: currentColor;
}

.sv-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
}

.sv-emoji {
  font-size: 14px;
  line-height: 1;
}

.sv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sv-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
}

.sv-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 两枚状态记号：小、不抢位置，但看得见 */
.sv-saved {
  flex: none;
  fill: none;
  stroke: var(--n-accent);
}

.sv-time {
  flex: none;
  font-size: 10.5px;
  color: var(--n-fg-dim);
}

.sv-prev {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--n-fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 条目上的标签：比筛选行那枚小一号、去掉胶囊边框，只留一个能点的文字，
   免得十几条列表里全是圆角块 */
.sv-item-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  overflow: hidden;
}
.sv-item-tag {
  flex: none;
  max-width: 92px;
  padding: 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: color-mix(in oklab, var(--n-accent) 78%, var(--n-fg-dim));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sv-item-tag:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.sv-item-tag.more {
  color: var(--n-fg-faint);
}

/* 删除按钮平时藏着，鼠标停上去才出现：列表一屏十几条，每条都挂一个红叉
   会让整列看起来很吵 */
.sv-del {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--n-fg-dim);
  opacity: 0;
  transition:
    opacity 130ms ease,
    background 130ms ease,
    color 130ms ease;
}
.sv-item:hover .sv-del {
  opacity: 1;
}
.sv-del svg {
  fill: none;
  stroke: currentColor;
}
.sv-del:hover {
  background: var(--n-surface);
  color: #c0392b;
}
.sv-del.confirm {
  opacity: 1;
  background: #c0392b;
  color: #fff;
}

.sv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 40px 20px;
  color: var(--n-fg-dim);
  text-align: center;
}
.sv-empty svg {
  fill: none;
  stroke: currentColor;
  opacity: 0.75;
}
.sv-empty p {
  margin: 0;
  font-size: 12.5px;
}
.sv-empty .sub {
  font-size: 11.5px;
  line-height: 1.6;
  opacity: 0.85;
}
.sv-empty kbd {
  display: inline-block;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--n-surface);
  border: 1px solid var(--n-line);
  font-family: inherit;
  font-size: 10.5px;
}

.sv-clear {
  margin-top: 4px;
  height: 24px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid var(--n-line);
  font-size: 11.5px;
  color: var(--n-fg-dim);
}
.sv-clear:hover {
  color: var(--n-fg);
  background: var(--n-surface);
}

.sv-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  padding: 0 6px 0 12px;
  border-top: 1px solid color-mix(in oklab, var(--n-line) 60%, transparent);
}

.sv-more {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 2px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--n-fg-dim);
  text-align: left;
}
.sv-more span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sv-more svg {
  flex: none;
  fill: none;
  stroke: currentColor;
  transition: transform var(--n-dur) var(--n-ease);
}
.sv-more.open svg {
  transform: rotate(180deg);
}
.sv-more:hover {
  color: var(--n-fg);
}

.sv-count {
  flex: 1;
  font-size: 11.5px;
  color: var(--n-fg-faint);
}

/* 底栏那几颗纯图标按钮：24px 见方，和上面的 .sv-folder 一套 */
.sv-icon-btn {
  flex: none;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--n-fg-dim);
  transition:
    background 120ms ease,
    color 120ms ease;
}
.sv-icon-btn svg {
  fill: none;
  stroke: currentColor;
}
.sv-icon-btn:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}
.sv-icon-btn:disabled {
  opacity: 0.34;
}
.sv-icon-btn:disabled:hover {
  background: none;
  color: var(--n-fg-dim);
}
.sv-icon-btn.danger:hover:not(:disabled) {
  color: #c0392b;
}
.sv-icon-btn.confirm,
.sv-icon-btn.confirm:hover {
  background: #c0392b;
  color: #fff;
}

/* 选择模式的底栏：左边张数 + 全选，中间四个动作，右边「完成」 */
.sv-foot.picking {
  padding: 0 8px;
  gap: 2px;
}
.sv-sel-n {
  flex: none;
  min-width: 30px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg);
}
.sv-sel-text {
  flex: none;
  height: 24px;
  padding: 0 5px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--n-fg-dim);
}
.sv-sel-text:hover {
  background: var(--n-surface);
  color: var(--n-fg);
}
.sv-sel-sep {
  flex: 1;
  min-width: 4px;
}
</style>
