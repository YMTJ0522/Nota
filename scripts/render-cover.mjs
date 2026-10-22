/**
 * 出朋友圈 / 小红书首图。
 *
 *   node scripts/render-cover.mjs
 *   → promo/cover-43.png（1080×1440）
 *
 * 为什么不用 `msedge --headless --screenshot`：那一条在这台机器上会静默失败 ——
 * 进程退出码 0、不打印 written、也不写文件（正在跑着的 Edge 会占住默认 profile）。
 * 项目里已经有 CDP harness，起独立 profile，稳。
 *
 * 舞台与素材都在 promo/：cover.html + icon.png（真图标）+ hero.png（真截图）。
 * 一个手画的图形都没有。
 */
import { launch } from './cdp-harness.mjs'

const PORT = Number(process.env.PORT || 4460)

const { send, evaluate, sleep, shot, close, errors } = await launch({
  port: PORT,
  size: [1080, 1440],
  scale: 1,
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/cover.html` })
await sleep(1600)

/* 等图真的解码完再拍，否则会拍到半张空框 */
await (async () => {
  for (let i = 0; i < 20; i++) {
    const ok = await evaluate(`(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0))()`)
    if (ok) return
    await sleep(200)
  }
})()

console.log('  →', await shot('promo/cover-43.png'))
if (errors.length) console.log('  控制台报错：', errors.slice(0, 3))
await close()
process.exit(0)
