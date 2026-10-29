/**
 * 便签在内存里**只有这一份**。
 *
 * 之前中间那一列（便签列表）和主区（便签墙）各自 `await window.api.stickyList()`
 * 存一份快照，然后靠 `store.stickyRev` 这个计数互相喊「我改过了，你重拉」。
 * 那套能跑，但是**补丁式**的：每多一个显示便签的地方（第三处、第四处），
 * 都得记得也挂一次 watch，漏一个就是「这边改了那边不动」—— 而漏掉是静默的，
 * 不报错，只是看着没反应。
 *
 * 现在改成一份数据：谁要显示便签就读 `stickyStore.items`，谁改了就调
 * `reloadStickies()` 重拉这一份。读的人不需要订阅任何东西，因为读的就是
 * 同一个 reactive 对象 —— 加第三个入口是「加个 reader」，不是「记得挂 watch」。
 *
 * 为什么还要留 `store.stickyRev`：那是给「写入方」用的信号（现有调用点都是
 * `touchStickies()`），下面这一个 watch 把它翻成一次重拉。信号在哪都能发，
 * 重拉只有这一处，不重复读盘。
 */
import { reactive, watch } from 'vue'
import { store } from './index'

export const stickyStore = reactive({
  /** 全部便签（含已收起、已存入），按主进程给的顺序 */
  items: [] as StickyItem[],
  /** 拉到过至少一次。空列表和「还没拉过」是两件事，空状态文案不一样 */
  loaded: false,
  loading: false,
})

let pending: Promise<void> | null = null
/** 重拉期间又有人喊了一次 —— 那一轮读到的可能是旧盘，得再读一遍 */
let again = false

/**
 * 从磁盘重读一遍。并发调用会合流成一次（真正的读盘只有一次），
 * 但**合流期间新来的请求会再跑一轮**：两次写盘紧挨着的时候，
 * 第一次重拉可能读在第二次写盘之前，只看第一轮就永远差一步。
 */
export function reloadStickies(): Promise<void> {
  if (pending) {
    again = true
    return pending
  }
  pending = (async () => {
    try {
      do {
        again = false
        stickyStore.loading = true
        try {
          /* 模块级 watch 是 immediate 的，可能在 preload 注入完之前就跑 ——
             拿不到 api 就当这次没读到，切视图时会再来一次 */
          if (!window.api?.stickyList) break
          stickyStore.items = await window.api.stickyList()
          stickyStore.loaded = true
        } catch {
          /* 读失败保留上一次的列表：一片空白比旧数据更容易让人以为便签丢了 */
        }
      } while (again)
    } finally {
      stickyStore.loading = false
      pending = null
    }
  })()
  return pending
}

/**
 * 本地先抹掉几条，再重拉。
 *
 * 删掉的那一瞬间列表上还挂着它、点一下还会去开一个已经不存在的文件 ——
 * 所以先就地摘掉（视觉上立刻消失），磁盘那一步和重拉随后跟上。
 */
export function dropFromStickies(ids: string[]) {
  const gone = new Set(ids)
  stickyStore.items = stickyStore.items.filter((s) => !gone.has(s.id))
  /* 勾选里也可能有它（右键删一张正在挑选的纸）。不摘掉的话「已选 N」会比
     实际多，下一轮「全选」还会把这个不存在的 id 一起带上。 */
  if (stickyPick.ids.length) stickyPick.ids = stickyPick.ids.filter((id) => !gone.has(id))
}

/**
 * 多选。
 *
 * 原来是便签列表自己的一份局部状态 —— 结果是同一批纸在右边那面墙上
 * 完全看不出「哪几张已经挑中了」：左列一排绿勾，墙上十几张纸长得一模一样，
 * 还得回左边数序号。所以提到这里，两个视角读同一份。
 *
 * 为什么不干脆在墙上也放一套批量按钮：那一屏是用来「看」的，动作都在左边
 * 那一列（顶栏就那么大）。墙上只负责把挑中的那几张标出来，点一下能加选/取消。
 */
export const stickyPick = reactive({
  /** 是不是在选择模式。关着的时候墙上不长勾选框 —— 常驻的勾选框会让纸不像纸 */
  on: false,
  ids: [] as string[],
})

export function enterPick(seed?: string) {
  stickyPick.on = true
  stickyPick.ids = seed ? [seed] : []
}

export function exitPick() {
  stickyPick.on = false
  stickyPick.ids = []
}

export function isPicked(id: string) {
  return stickyPick.ids.includes(id)
}

export function togglePicked(id: string) {
  stickyPick.ids = isPicked(id) ? stickyPick.ids.filter((x) => x !== id) : [...stickyPick.ids, id]
}

/* 唯一的订阅点。三种变化都只影响便签，而且都该重拉：
   · 便签窗口开了 / 关了（主进程推张数过来，App 存进 store）
   · 写入方调了 touchStickies()
   · 切到便签视图（拉一次最新的，别人可能在别处改过盘） */
watch(
  () => [store.state.columnView, store.state.stickyOpen, store.state.stickyRev] as const,
  () => {
    if (store.state.columnView === 'stickies') void reloadStickies()
  },
  { immediate: true },
)
