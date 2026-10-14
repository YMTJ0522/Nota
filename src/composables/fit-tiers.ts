/**
 * 「这一排放得下几样东西」由它自己量出来，而不是写一堆像素阈值。
 *
 * 为什么：以前那种「宽度小于 XXX 就收掉 YYY」的写法，阈值是照着当时的字号
 * 和当时的按钮数量写死的 —— 加一枚按钮、换一版字距，数字立刻就不准了，
 * 而且只对某一类内容准。行自己知道它装得下多少：scrollWidth 比 clientWidth 大
 * 就是溢出，照着这个从松到紧试一遍。
 *
 * 用法：`const tier = useFitTiers(rowEl, 3)`，再把 tier 打到 `data-crammed` 上，
 * CSS 里按 `[data-crammed="1"]`、[data-crammed="2"]… 从最无关紧要的开始收。
 * 档位从 0（什么都不收）到 maxTier（收得最狠）。
 */
import { ref, onMounted, onBeforeUnmount, type Ref } from 'vue'

export function useFitTiers(rowEl: Ref<HTMLElement | null>, watchEl: Ref<HTMLElement | null>, maxTier = 4) {
  const tier = ref(0)
  let ro: ResizeObserver | null = null
  let mo: MutationObserver | null = null
  let queued = 0
  let fitting = false

  function fit() {
    const el = rowEl.value
    if (!el) return
    fitting = true
    let t = maxTier
    for (let i = 0; i <= maxTier; i++) {
      // 直接写 dataset 而不是改 ref：Vue 更新是异步的，这里需要写完立刻重排再量
      el.dataset.crammed = String(i)
      if (el.scrollWidth <= el.clientWidth + 1) {
        t = i
        break
      }
    }
    if (tier.value !== t) tier.value = t
    fitting = false
  }

  /**
   * 光看尺寸变化是不够的 —— **内容**变了而宽度没变时，原来那一档就不对了。
   *
   * 资料栏顶行最典型：在「AI 编写」这一屏上它只有一个名字加按钮，宽裕得很，
   * 档位停在 0；切回「笔记」页签，同一行要塞三个页签，宽度一点没变，
   * ResizeObserver 不会触发，于是顶行溢出 —— 960px 的窗口上，最右边那枚
   * 「收起这一栏」会被切掉一半。
   *
   * 所以这里再挂一个 MutationObserver 看着这一行的子节点增删。
   * 只听 childList / subtree，不听 attributes —— 上面 fit() 一上来就写
   * dataset，听属性的话会自己把自己叫起来。
   */
  function refit() {
    if (fitting || queued) return
    queued = requestAnimationFrame(() => {
      queued = 0
      fit()
    })
  }

  onMounted(() => {
    const target = watchEl.value ?? rowEl.value
    if (!target) return
    ro = new ResizeObserver(() => fit())
    ro.observe(target)
    const row = rowEl.value
    if (row) {
      mo = new MutationObserver(refit)
      mo.observe(row, { childList: true, subtree: true })
    }
    fit()
  })

  onBeforeUnmount(() => {
    ro?.disconnect()
    ro = null
    if (queued) cancelAnimationFrame(queued)
    mo?.disconnect()
    mo = null
  })

  return { tier, fit }
}
