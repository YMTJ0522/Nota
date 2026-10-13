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

  function fit() {
    const el = rowEl.value
    if (!el) return
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
  }

  onMounted(() => {
    const target = watchEl.value ?? rowEl.value
    if (!target) return
    ro = new ResizeObserver(() => fit())
    ro.observe(target)
    fit()
  })

  onBeforeUnmount(() => {
    ro?.disconnect()
    ro = null
  })

  return { tier, fit }
}
