/**
 * 把 cards.html 里的六张卡片逐张截成 1080×1080 的 PNG，给朋友圈发。
 *
 * 为什么不用系统截图：卡片要精确的 1080 方图、位置固定、六张必须像素级一致，
 * 手工拖窗口做不到。这里用同一套无头 Edge 相机，只是把镜头对准每一张卡。
 *
 * 注意 WEB_ROOT 必须在 import 之前设 —— cdp-harness 在模块求值时就定了静态根，
 * 晚了它还在服务 dist/，页面会 404。
 */
process.env.WEB_ROOT = 'promo'

const { launch } = await import('../scripts/cdp-harness.mjs')

const CARDS = [
  ['c1', '01-封面.png'],
  ['c2', '02-代码块.png'],
  ['c3', '03-关系图.png'],
  ['c4', '04-搜索.png'],
  ['c5', '05-深色.png'],
  ['c6', '06-下载.png'],
]

const { send, evaluate, sleep, shot, boxOf, close, errors } = await launch({
  port: 4488,
  cdpPort: 9972,
  size: [1080, 1080],
  scale: 1,
})

await send('Page.navigate', { url: 'http://127.0.0.1:4488/' })
await sleep(1200)

/* 等字体和六张素材都真的到位再拍 —— 少一张就是一块白，
   而 PNG 一旦发出去没人会回头检查。 */
await evaluate(`(async () => {
  await document.fonts.ready
  const imgs = [...document.images]
  await Promise.all(imgs.map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r })))
  return imgs.filter((i) => !i.naturalWidth).length
})()`)

const missing = await evaluate(`[...document.images].filter((i) => !i.naturalWidth).map((i) => i.src)`)
if (missing.length) console.log('⚠ 有图没加载出来：', missing)

for (const [id, file] of CARDS) {
  await evaluate(`document.getElementById('${id}').scrollIntoView({ block: 'start', behavior: 'instant' })`)
  await sleep(220)
  const box = await boxOf(`#${id}`)
  /* clip 用的是**页面坐标**，boxOf 给的是视口坐标 —— 少加这一项，
     六张就会全截成页面顶部那一块（表现为五张图字节数完全相同）。 */
  const scrollY = await evaluate(`window.scrollY`)
  const out = await shot(`promo/out/${file}`, {
    x: box.x,
    y: box.y + scrollY,
    width: box.w,
    height: box.h,
  })
  console.log(`  → ${out}  ${Math.round(box.w)}×${Math.round(box.h)}  (scrollY ${Math.round(scrollY)})`)
}

if (errors.length) console.log('页面报错：', errors.slice(0, 5))
await close()
console.log('done')
