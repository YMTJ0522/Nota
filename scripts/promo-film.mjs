/**
 * 产品宣传片：驱动**真实运行的 Nota**（dist + 打桩 IPC），逐帧截图，带运镜。
 *
 * 跟 promo/ 里那几张海报不是一回事：海报是排版排出来的；这里是真应用 ——
 * 笔记真点开、字真敲进去、图表真渲染、便签墙真铺开。片子里看到什么，
 * 装完就是什么样。
 *
 *   node scripts/promo-film.mjs --still   # 只出关键帧（检查用，几秒钟）
 *   node scripts/promo-film.mjs           # 录整片 → release/promo.mp4
 *
 * 为什么不用录屏软件：运镜是「推到某个控件上 1.8 倍」这种精确动作，
 * 手工录一遍要重来十次；而且镜头缩放会连窗口边缘一起缩，画面外就露背景。
 * 这里是把 body 做 transform，截图由 CDP 给，稳。
 */
process.env.WEB_ROOT = 'dist'

const fs = await import('node:fs')
const path = await import('node:path')
const { spawn } = await import('node:child_process')
const { fileURLToPath } = await import('node:url')
const { launch } = await import('./cdp-harness.mjs')
const { makeInject } = await import('./fake-workspace.mjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STILL = process.argv.includes('--still')
const STILL_DIR = path.join(root, '.trash', 'film-stills')
const OUT = process.env.OUT || 'release/promo.mp4'

const W = 1600
const H = 900
const FPS = 30

/* ────────────────────────── 演示用的那篇笔记 ──────────────────────────
   全是真的能渲染的东西：待办、提示块、代码（带行号+高亮行）、
   流程图、表格、公式、双链。片子里要推近给人看清的就是这些。 */
const NOTE = [
  '# 一周手记',
  '',
  '*「把想法写下来，它们才会长成东西。」*',
  '',
  '## 这周做了什么',
  '',
  '- [x] 把资料库迁到本地目录',
  '- [x] 给编辑器补上代码块行号',
  '- [ ] 整理读书笔记的双链',
  '',
  '> [!tip] 小技巧',
  '> 围栏后面写 `line-numbers` 就显示行号，写 `{3}` 还能高亮某一行。',
  '',
  '## 一段代码',
  '',
  '```ts title="notes.ts" line-numbers {3}',
  'export interface Note {',
  '  path: string',
  '  tags: string[]',
  '  updatedAt: number',
  '}',
  '',
  'export function isFresh(n: Note, days = 7) {',
  '  return Date.now() - n.updatedAt < days * 86400_000',
  '}',
  '```',
  '',
  '## 图表与表格',
  '',
  '```mermaid',
  'graph LR',
  '  A[想法] --> B[笔记]',
  '  B --> C[整理]',
  '  C --> D[输出]',
  '```',
  '',
  '| 项目 | 状态 | 耗时 |',
  '| --- | --- | --- |',
  '| 资料库 | 完成 | 2 天 |',
  '| 编辑器 | 完成 | 3 天 |',
  '| 双链 | 进行中 | — |',
  '',
  '## 一个公式',
  '',
  '$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$',
  '',
  '相关：[[读书笔记]]、[[接口设计]]。',
  '',
].join('\n')

const file = (name, dir, extra = {}) => ({
  type: 'file',
  name,
  path: `${dir ? `/ws/${dir}` : '/ws'}/${name}`,
  tags: [],
  starred: false,
  mtime: Date.now(),
  excerpt: '',
  ...extra,
})

const TREE = [
  {
    type: 'dir',
    name: '笔记归档 2026',
    path: '/ws/笔记归档 2026',
    children: [
      file('一周手记.md', '笔记归档 2026', { tags: ['手记'], starred: true, mtime: Date.now() - 3600_000 }),
      file('读书笔记.md', '笔记归档 2026', { tags: ['阅读'], mtime: Date.now() - 86400_000 * 3 }),
      file('待办.md', '笔记归档 2026', { starred: true, mtime: Date.now() - 7200_000 }),
      file('接口设计.md', '笔记归档 2026', { mtime: Date.now() - 86400_000 * 8 }),
      file('改版记录.md', '笔记归档 2026', { tags: ['版本'], mtime: Date.now() - 86400_000 * 2 }),
      file('摘抄.md', '笔记归档 2026', { tags: ['阅读'], mtime: Date.now() - 86400_000 * 6 }),
    ],
  },
]

/* 双链要连成「网」，不能只有两颗卫星围着中心 —— 关系图那一段的旁白
   就是「双链写下去，自己连成一张网」，图上得真有一张网。
   下面这几条互相牵：一周手记 ↔ 读书笔记 ↔ 待办 ↔ 接口设计 ↔ 一周手记。 */
const NOTES = {
  '/ws/笔记归档 2026/一周手记.md': NOTE,
  '/ws/笔记归档 2026/读书笔记.md':
    '# 读书笔记\n\n在读《设计中的设计》。\n\n另见 [[一周手记]]，摘抄先归到 [[待办]] 里。\n',
  '/ws/笔记归档 2026/待办.md':
    '# 待办\n\n- [ ] 整理旧稿\n- [ ] 把备份脚本挪到 cron\n\n接着 [[一周手记]] 往下走，接口那边见 [[接口设计]]。\n',
  '/ws/笔记归档 2026/接口设计.md':
    '# 接口设计\n\n## GET /notes\n\n返回笔记列表。\n\n关联 [[一周手记]]，字段先照 [[待办]] 里记的来。\n',
  '/ws/笔记归档 2026/改版记录.md':
    '# 改版记录\n\n## 2.10.1\n\n把两档次要文字压深了一档。\n\n见 [[一周手记]]、[[接口设计]]。\n',
  '/ws/笔记归档 2026/摘抄.md':
    '# 摘抄\n\n「空」不是没有，是留出来的地方。\n\n摘自 [[读书笔记]]，整理进 [[待办]]。\n',
}

/* 便签墙上那几张纸。字段是 title / preview（不是 text）——
   StickyBoard 的卡片模板读的是这两个，塞错了卡片上就只剩一个时间。 */
const STICKIES = [
  {
    id: 's1',
    title: 'compose 的 healthcheck 补上',
    preview: '等 mysql 起来再起 api，现在每次都抢跑',
    color: 'amber',
    tags: ['docker'],
    closedAt: null,
    pinned: false,
    icon: { kind: 'emoji', id: '🐳' },
    updatedAt: Date.now() - 3600_000,
  },
  {
    id: 's2',
    title: '把备份脚本挪到 cron',
    preview: '03:20 跑，别和日志切割撞上',
    color: 'mint',
    tags: ['运维'],
    closedAt: null,
    pinned: false,
    icon: { kind: 'emoji', id: '🗂️' },
    updatedAt: Date.now() - 7200_000,
  },
  {
    id: 's3',
    title: 'nginx 502 先看 upstream',
    preview: '端口对不对，别一上来就翻日志',
    color: 'rose',
    tags: [],
    closedAt: null,
    pinned: false,
    updatedAt: Date.now() - 10800_000,
  },
  {
    id: 's4',
    title: '《设计中的设计》接着看',
    preview: '停在第 62 页，原研哉讲「空」的那段',
    color: 'sky',
    tags: ['阅读'],
    closedAt: null,
    pinned: false,
    icon: { kind: 'emoji', id: '📖' },
    updatedAt: Date.now() - 86400_000,
  },
  /* 只放四张的话，便签墙在 16:9 的片子里下半屏全是空的 —— 真实用起来桌上
     本来就会摊开七八张。补到八张，一屏铺满两行，画面才站得住。 */
  {
    id: 's5',
    title: 'GraphView 加个缩放上限',
    preview: '滚轮一快就飞出画布，得能一键回到常态',
    color: 'lilac',
    tags: ['前端'],
    closedAt: null,
    pinned: false,
    icon: { kind: 'emoji', id: '🕸️' },
    updatedAt: Date.now() - 1800_000,
  },
  {
    id: 's6',
    title: '磁盘到 80% 之前清一次',
    preview: '先看 logrotate 的配置，别上手就删 /var/log',
    color: 'amber',
    tags: ['运维'],
    closedAt: null,
    pinned: true,
    icon: { kind: 'emoji', id: '🧹' },
    updatedAt: Date.now() - 5400_000,
  },
  {
    id: 's7',
    title: '周报模板再短一点',
    preview: '三段就够：做了什么、卡在哪、下周要什么',
    color: 'slate',
    tags: ['写作'],
    closedAt: null,
    pinned: false,
    icon: { kind: 'emoji', id: '✍️' },
    updatedAt: Date.now() - 86400_000 * 2,
  },
  {
    id: 's8',
    title: '截图按月份归档',
    preview: '文件名用日期开头，排序出来就是时间线',
    color: 'mint',
    tags: ['整理'],
    closedAt: null,
    pinned: false,
    icon: { kind: 'emoji', id: '🗃️' },
    updatedAt: Date.now() - 86400_000 * 5,
  },
]

/* ────────────────────────── 起相机 ────────────────────────── */
const cam0 = { k: 1, x: W / 2, y: H / 2 }
const { send, evaluate, sleep, close } = await launch({
  port: 4511,
  cdpPort: 9990,
  size: [W, H],
  scale: 2,
})

await send('Page.navigate', { url: 'http://127.0.0.1:4511/' })
await sleep(1800)
/* 主题存在 localStorage 的 nota-theme 里。上一次录制留了深色，不清掉的话
   整片都是黑底 —— 这套界面的第一印象是那张暖白纸，片子得以浅色为主。 */
await evaluate(`localStorage.setItem('nota-tour-seen','1'), localStorage.setItem('nota-theme','light')`)
await send('Page.reload', {})
await sleep(2200)

const inject = makeInject({ notes: NOTES, tree: TREE })
await evaluate(inject)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(inject)
await evaluate(`window.__stickies = ${JSON.stringify(STICKIES)}`)
await sleep(700)

/* 注入层：鼠标 / 涟漪 / 字幕 / 片尾。
   全部挂在 <html> 上 —— 运镜的 transform 加在 body，这些是 body 的兄弟节点，
   不会被一起缩放，所以永远是「屏幕坐标」。 */
await evaluate(`(() => {
  document.documentElement.style.overflow = 'hidden'
  /* 运镜是给 body 加 transform。镜头推近时 body 的边缘会离开视口，
     不铺一层底色就会露出浏览器默认的白/黑 —— 在深色下尤其难看。 */
  document.documentElement.style.background = '#faf9f6'
  const c = document.createElement('div')
  c.id = '__cursor'
  c.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;' +
    'pointer-events:none;will-change:transform;transform:translate3d(-300px,-300px,0);' +
    'filter:drop-shadow(0 1.5px 3px rgb(0 0 0/.5))'
  c.innerHTML = '<svg width="30" height="30" viewBox="0 0 26 26" fill="none">' +
    '<path d="M4 2.2 L4 20.4 L8.9 15.6 L12.2 22.6 L15.3 21.2 L12 14.2 L18.6 13.7 Z" ' +
    'fill="#fff" stroke="#16150f" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  document.documentElement.appendChild(c)

  const r = document.createElement('div')
  r.id = '__ripple'
  r.style.cssText = 'position:fixed;left:-200px;top:-200px;width:12px;height:12px;border-radius:50%;' +
    'z-index:2147483646;pointer-events:none;opacity:0;' +
    'border:3px solid rgb(47 111 82/.85);background:rgb(47 111 82/.14)'
  document.documentElement.appendChild(r)

  const cap = document.createElement('div')
  cap.id = '__cap'
  cap.style.cssText = 'position:fixed;left:56px;bottom:54px;z-index:2147483645;opacity:0;' +
    'pointer-events:none;display:flex;align-items:center;gap:14px;' +
    'background:rgb(22 22 18/.88);color:#f7f5ee;padding:15px 26px;border-radius:12px;' +
    'font:600 24px/1.35 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;' +
    'box-shadow:0 18px 40px -18px rgb(0 0 0/.6);letter-spacing:.01em;transform:translateY(8px)'
  cap.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#4fbf8f;flex:none"></span>' +
    '<span id="__captext"></span>'
  document.documentElement.appendChild(cap)

  const end = document.createElement('div')
  end.id = '__end'
  end.style.cssText = 'position:fixed;inset:0;z-index:2147483644;opacity:0;pointer-events:none;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'background:radial-gradient(1200px 800px at 50% 40%,#fdfcf7,#f4f2e8 70%,#eeece0);' +
    'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1f1e1a'
  end.innerHTML =
    '<div style="width:132px;height:132px;border-radius:31px;background:linear-gradient(158deg,#4a7f66,#2c5240);' +
      'display:flex;align-items:center;justify-content:center;font:800 68px Georgia,serif;color:#f3f8f4;' +
      'box-shadow:0 34px 60px -26px rgb(20 60 44/.55)">N</div>' +
    '<div style="margin-top:34px;font-size:64px;font-weight:800;letter-spacing:-.03em">Nota</div>' +
    '<div style="margin-top:14px;font-size:24px;color:#8d897e;letter-spacing:.14em">一个只做笔记的笔记应用</div>' +
    '<div style="margin-top:40px;font-size:31px;font-weight:700;color:#2f6f52">ymtj.hyper99.top</div>' +
    '<div style="margin-top:16px;font-size:20px;color:#8d897e">Windows 10 / 11 · 免费开源 · 不联网、不上传、不要账号</div>'
  document.documentElement.appendChild(end)

  const intro = document.createElement('div')
  intro.id = '__intro'
  intro.style.cssText = 'position:fixed;inset:0;z-index:2147483643;pointer-events:none;opacity:1;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;background:#faf7f1;' +
    'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#171614'
  intro.innerHTML =
    '<div style="display:flex;align-items:center;gap:22px">' +
      '<div style="width:86px;height:86px;border-radius:21px;background:linear-gradient(158deg,#4a7f66,#2c5240);' +
        'display:flex;align-items:center;justify-content:center;font:800 45px Georgia,serif;color:#f3f8f4">N</div>' +
      '<div style="font-size:74px;font-weight:800;letter-spacing:-.035em">Nota</div>' +
    '</div>' +
    '<div style="margin-top:26px;font-size:27px;color:#8d897e;letter-spacing:.05em">一个只做笔记的笔记应用</div>' +
    '<div style="margin-top:18px;font-family:Georgia,serif;font-style:italic;font-size:20px;color:#a9a396">' +
      'a notebook that only takes notes</div>'
  document.documentElement.appendChild(intro)
  return true
})()`)

/* ────────────────────────── 运镜引擎 ────────────────────────── */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)
const easeIn = (t) => t * t * t
const EASES = { inout: easeInOut, out: easeOut, in: easeIn }
const lerp = (a, b, p) => a + (b - a) * p

let cam = { ...cam0 }
let cursor = { x: -300, y: -300 }
let ripple = { x: 0, y: 0, at: -99 }
let T = 0
let frameCount = 0
let capText = ''

const setCam = (k, cx, cy) =>
  evaluate(`(() => { const b=document.body;
    b.style.transformOrigin='0 0';
    b.style.transform='translate(${W / 2 - cx * k}px,${H / 2 - cy * k}px) scale(${k})';
    return true })()`)

const screenOf = (p, c) => ({ x: (p.x - c.x) * c.k + W / 2, y: (p.y - c.y) * c.k + H / 2 })
const toPage = (sx, sy) => ({ x: (sx - W / 2) / cam.k + cam.x, y: (sy - H / 2) / cam.k + cam.y })

const paintCursor = (s, press) =>
  evaluate(`(() => { const c=document.getElementById('__cursor'); if(!c) return false;
    c.style.transform='translate3d(${s.x - 4}px,${s.y - 3}px,0) scale(${press ? .9 : 1})';
    c.style.transformOrigin='4px 2px'; return true })()`)

const paintRipple = (s, p) =>
  evaluate(`(() => { const r=document.getElementById('__ripple'); if(!r) return false;
    const d=14+${p}*64; r.style.width=d+'px'; r.style.height=d+'px';
    r.style.left=(${s.x}-d/2)+'px'; r.style.top=(${s.y}-d/2)+'px';
    r.style.opacity=String((1-${p})*0.9); return true })()`)

const paintCap = (text, op) =>
  evaluate(`(() => { const c=document.getElementById('__cap'); if(!c) return false;
    const t=document.getElementById('__captext');
    if (t.textContent !== ${JSON.stringify(text)}) t.textContent = ${JSON.stringify(text)};
    c.style.opacity=String(${op});
    c.style.transform='translateY(' + ((1-${op})*10).toFixed(1) + 'px)';
    return true })()`)

const paintEnd = (op) =>
  evaluate(`(() => { const e=document.getElementById('__end'); if(!e) return false;
    e.style.opacity=String(${op}); return true })()`)

const paintIntro = (op) =>
  evaluate(`(() => { const e=document.getElementById('__intro'); if(!e) return false;
    e.style.opacity=String(${op}); return true })()`)

let ff = null
if (!STILL) {
  fs.mkdirSync(path.dirname(path.resolve(root, OUT)), { recursive: true })
  ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-vf', 'scale=1920:1080:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.resolve(root, OUT),
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
}

const emit = async (opt = {}) => {
  await setCam(cam.k, cam.x, cam.y)
  const s = screenOf(cursor, cam)
  await paintCursor(s, opt.press ?? false)
  const rp = clamp((T - ripple.at) / .42)
  if (T >= ripple.at && rp < 1) await paintRipple(screenOf(ripple, cam), rp)
  else if (rp >= 1) await evaluate("(() => { const r=document.getElementById('__ripple'); if(r) r.style.opacity='0'; return true })()")
  if (opt.cap !== undefined) capText = opt.cap
  if (opt.cap !== undefined || opt.capOp !== undefined) await paintCap(capText, opt.capOp ?? 1)
  if (!STILL) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const buf = Buffer.from(r.data, 'base64')
    if (!ff.stdin.write(buf)) await new Promise((res) => ff.stdin.once('drain', res))
  }
  T += 1 / FPS
  frameCount++
}

let stillN = 0
const mark = async (name) => {
  if (!STILL) return
  fs.mkdirSync(STILL_DIR, { recursive: true })
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const f = path.join(STILL_DIR, `${String(++stillN).padStart(2, '0')}-${name}.png`)
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
  console.log('  帧 →', path.basename(f), ' t=' + T.toFixed(1) + 's')
}

/* ────────────────────────── 定位与动作 ────────────────────────── */
const rectOf = (sel, text) => evaluate(`(() => {
  const list = ${JSON.stringify(text)} === null ? [document.querySelector(${JSON.stringify(sel)})]
    : [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => (e.textContent || '').includes(${JSON.stringify(text ?? '')}))
  const el = list.filter(Boolean)[0]
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
})()`)

const resolveTarget = async (spec) => {
  if (!spec) return null
  if (spec.x !== undefined) return { x: spec.x, y: spec.y }
  const r = await rectOf(spec.on, spec.text ?? null)
  if (!r) {
    console.warn('  ! 找不到', spec.on, spec.text ?? '')
    return null
  }
  return toPage(r.x + (spec.dx ?? 0), r.y + (spec.dy ?? 0))
}

/** 真实鼠标点一下（CodeMirror 定位光标必须走这条路，DOM click 不会移动光标） */
const realClickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1 })
}

async function shot({ dur, cam: camTo, cursor: curTo, ease = 'inout', cap, capOp, action, at = .55 }) {
  const n = Math.max(1, Math.round(dur * FPS))
  const c2 = camTo ? await resolveTarget(camTo) : null
  const k2 = camTo ? (camTo.k ?? cam.k) : cam.k
  const p2 = curTo ? await resolveTarget(curTo) : null
  const c1 = { ...cam }
  const p1 = { ...cursor }
  const ez = EASES[ease]
  let acted = false
  for (let i = 1; i <= n; i++) {
    const e = ez(i / n)
    cam = { k: lerp(c1.k, k2, e), x: lerp(c1.x, c2 ? c2.x : c1.x, e), y: lerp(c1.y, c2 ? c2.y : c1.y, e) }
    if (p2) cursor = { x: lerp(p1.x, p2.x, e), y: lerp(p1.y, p2.y, e) }
    if (!acted && action && i / n >= at) { acted = true; await action() }
    await emit({ cap, capOp })
  }
}

async function hold(dur, opt = {}) {
  const n = Math.max(1, Math.round(dur * FPS))
  for (let i = 0; i < n; i++) await emit(opt)
}

/** 推到控件上 → 涟漪 → DOM 点击（按钮类用它，稳） */
async function clickZoom(sel, { text = null, k = 1.9, dur = .8, cap } = {}) {
  await shot({ dur, cam: { on: sel, k, ...(text ? { text } : {}) }, cursor: { on: sel, ...(text ? { text } : {}) }, ease: 'out', cap })
  await hold(.16, { cap })
  ripple = { ...cursor, at: T }
  await paintRipple(screenOf(cursor, cam), 0)
  const r = await rectOf(sel, text)
  if (r) await realClickAt(r.x, r.y)
  await emit({ press: true, cap })
  await emit({ cap })
  await hold(.28, { cap })
}

const key = async (k, code, vk, text) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}

/** 带修饰键的按键：modifiers 是 CDP 位掩码（Alt=1 Ctrl=2 Meta=4 Shift=8）。
    AI 镜头选整行用 Shift+End，导图镜头用 Ctrl+Shift+M。 */
const keyMod = async (k, code, vk, mods) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods })
}

/** 真实右键（编辑器右键菜单只认 contextmenu 事件链） */
const rightClickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'right', buttons: 2, clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'right', buttons: 0, clickCount: 1 })
}

/** 逐字敲进去。中文用 insertText，右侧预览会同步重排。 */
async function typeText(text) {
  for (const ch of [...text]) {
    await send('Input.insertText', { text: ch })
    await emit({})
    if ('，。、'.includes(ch)) await emit({})
  }
}

async function wheelPreview(dy, n, cap) {
  /* 滚轮事件的坐标是**屏幕坐标**，而运镜一直在动 —— 每帧重新量一次预览栏中心，
     不能把页面坐标当屏幕坐标喂进去（那样滚的是别处，画面纹丝不动）。 */
  for (let i = 0; i < n; i++) {
    const r = await evaluate(`(() => {
      const p = document.querySelector('.preview'); if (!p) return null
      const b = p.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    })()`)
    if (r) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(r.x), y: Math.round(r.y),
        deltaX: 0, deltaY: dy / n, button: 'none',
      })
    }
    await emit({ cap })
  }
}

/** 把预览栏平滑滚到某个小节标题。
 *  用 scrollTop 插值而不是滚轮：滚轮的 deltaY 会被浏览器按倍率放大，
 *  想精确停在「图表与表格」那一节基本靠运气；这里直接按 DOM 位置算落点。 */
async function scrollPreviewTo(text, dur, cap) {
  const from = await evaluate(`(() => { const p = document.querySelector('.preview'); return p ? p.scrollTop : 0 })()`)
  const to = await evaluate(`(() => {
    const p = document.querySelector('.preview'); if (!p) return null
    const h = [...p.querySelectorAll('h2')].find((e) => e.textContent.includes(${JSON.stringify(text)}))
    if (!h) return null
    /* getBoundingClientRect 拿到的是**已经过运镜缩放**的屏幕距离，而 scrollTop
       是布局单位 —— 两者相差一个 k。之前直接相加，运镜一推近，滚动量就被放大
       近一倍，落点跑到下一节去，代码块直接被滚到画面外。 */
    const k = ${cam.k}
    const top = (h.getBoundingClientRect().top - p.getBoundingClientRect().top) / k + p.scrollTop
    return Math.round(Math.max(0, Math.min(top - 80, p.scrollHeight - p.clientHeight)))
  })()`)
  if (to === null) {
    console.warn('  ! 预览里找不到小节', text)
    return
  }
  const n = Math.max(2, Math.round(dur * FPS))
  for (let i = 1; i <= n; i++) {
    const v = Math.round(lerp(from, to, easeInOut(i / n)))
    await evaluate(`(() => { const p = document.querySelector('.preview'); if (p) p.scrollTop = ${v}; return true })()`)
    await emit({ cap })
  }
}

/* ────────────────────────── 分镜 ────────────────────────── */
const CAP = {
  intro: 'Nota · 一个只做笔记的笔记应用',
  files: '笔记就是硬盘上的 .md 文件',
  split: '左边写，右边同时渲染',
  type: '敲字的同时，右边跟着变',
  code: '代码块：行号、指定行高亮、语言标签',
  chart: '图表、表格、公式，都是真渲染',
  graph: '双链写下去，自己连成一张网',
  ai: 'AI 编写：选中一段，一键润色',
  map: '思维导图：一篇笔记的结构，一眼看清',
  sticky: '随手记：按一下 Alt+N，弹一张纸',
  dark: '夜里写，换一张纸就行',
}

/* ⓞ 片头：纸色卡先压着，2 秒后淡出露出真实界面 */
await evaluate(`document.getElementById('__intro').style.opacity = '1'`)
for (let i = 0; i < Math.round(1.1 * FPS); i++) await emit({ capOp: 0 })
const nIntro = Math.round(.55 * FPS)
for (let i = 1; i <= nIntro; i++) {
  await paintIntro(1 - i / nIntro)
  await emit({ capOp: 0 })
}
await mark('intro-out')

/* ① 整窗 → 直接推到列表。开场不能停在空状态：
   观众第一眼得看到「这是一堆真笔记」，而不是一行「从左侧选一篇」。 */
await shot({ dur: 1.2, cam: { k: 1.3, x: 530, y: 360 }, cursor: { x: 380, y: 150 }, cap: CAP.files })
await mark('overview')

/* ② 推到笔记列表，点开《一周手记》 */
await shot({ dur: .9, cam: { on: '.nl-item', text: '一周手记', k: 1.75 }, cursor: { on: '.nl-item', text: '一周手记', dx: -30 }, ease: 'out', cap: CAP.files })
await mark('list')
ripple = { ...cursor, at: T }
await paintRipple(screenOf(cursor, cam), 0)
{
  const r = await rectOf('.nl-item', '一周手记')
  if (r) await realClickAt(r.x, r.y)
  else console.warn('  ! 没找到「一周手记」')
}
await emit({ press: true, cap: CAP.files })
await emit({ cap: CAP.files })
await sleep(700)
await hold(.4, { cap: CAP.files })

/* ③ 拉回来看整屏：编辑 + 预览并排 */
await shot({ dur: 1.0, cam: { x: 880, y: 470, k: 1.12 }, cursor: { x: 700, y: 500 }, ease: 'inout', cap: CAP.split })
await mark('split')
await hold(.5, { cap: CAP.split })

/* ④ 推到待办那一行，光标落到行尾 */
await shot({ dur: 1.0, cam: { on: '.cm-line', text: '整理读书笔记的双链', k: 1.85 }, cursor: { on: '.cm-line', text: '整理读书笔记的双链', dx: 95 }, ease: 'out', cap: CAP.type })
await mark('type-before')

const eol = await evaluate(`(() => {
  const l = [...document.querySelectorAll('.cm-line')].find(e => e.textContent.includes('整理读书笔记的双链'))
  if (!l) return null
  const rg = document.createRange(); rg.selectNodeContents(l)
  const r = rg.getBoundingClientRect()
  return { x: r.right - 2, y: r.top + r.height / 2 }
})()`)
if (eol) await realClickAt(eol.x, eol.y)
else console.warn('  ! 没找到那一行')
await key('End', 'End', 35)
await key('Enter', 'Enter', 13, '\r')
await emit({})
await typeText('把每周回顾压到 15 分钟')
await mark('typed')
await hold(.3, { cap: CAP.type })

/* ⑤ 看右边新长出来的那一条 */
await shot({ dur: .9, cam: { on: '.preview li', text: '把每周回顾', k: 1.95 }, cursor: { on: '.preview li', text: '把每周回顾', dx: -40 }, ease: 'out', cap: CAP.type })
await mark('preview-new')
await hold(.7, { cap: CAP.type })

/* ⑤½ AI 润色：选中引言那一行 → 右键 → 润色这段。
   打桩 IPC 秒回，但镜头节奏按真请求拍：选区先停一拍让人看清，
   菜单点完等一拍再拉镜头看替换结果。 */
await shot({ dur: .9, cam: { on: '.cm-line', text: '把想法写下来', k: 1.9 }, cursor: { on: '.cm-line', text: '把想法写下来', dx: -170 }, ease: 'out', cap: CAP.ai })
{
  const r = await rectOf('.cm-line', '把想法写下来')
  if (r) {
    await realClickAt(r.left + 3, r.y)
    await keyMod('End', 'End', 35, 8) // Shift+End：选中到行尾
  } else console.warn('  ! 没找到引言行')
}
await emit({ cap: CAP.ai })
await hold(.4, { cap: CAP.ai })
await mark('ai-select')
{
  const r = await rectOf('.cm-line', '把想法写下来')
  if (r) await rightClickAt(r.x, r.y)
}
await sleep(500)
await clickZoom('.ctx-item', { text: '润色这段', k: 2.0, dur: .8, cap: CAP.ai })
await mark('ai-menu')
await sleep(700)
await shot({ dur: 1.0, cam: { on: '.cm-line', text: '慢慢长成真正的样子', k: 2.1 }, ease: 'out', cap: CAP.ai })
await mark('ai-after')
await hold(1.0, { cap: CAP.ai })

/* ⑥ 滚预览：代码块 → 图表 → 表格 → 公式，镜头贴着块走 */
await scrollPreviewTo('一段代码', 1.0, CAP.code)
await shot({ dur: .9, cam: { on: '.preview pre', k: 1.7 }, cursor: { x: 1100, y: 470 }, ease: 'out', cap: CAP.code })
await mark('code')
await hold(1.0, { cap: CAP.code })

await scrollPreviewTo('图表与表格', 1.2, CAP.chart)
await shot({ dur: .8, cam: { on: '.preview .pv-mermaid', k: 1.9 }, ease: 'out', cap: CAP.chart })
await mark('chart')
await hold(1.2, { cap: CAP.chart })

await shot({ dur: .7, cam: { on: '.preview table', k: 1.75 }, ease: 'out', cap: CAP.chart })
await mark('table')
await hold(.9, { cap: CAP.chart })

await scrollPreviewTo('一个公式', .9, CAP.chart)
/* 公式那块本来就只有一行高，2 倍下在画面里是小小的一个符号 —— 推到 2.8 才看得出
   「这是真的排版出来的积分号，不是贴图」。 */
await shot({ dur: .8, cam: { on: '.preview .pv-math-block', k: 2.8 }, ease: 'out', cap: CAP.chart })
await mark('formula')
await hold(.9, { cap: CAP.chart })

/* ⑦ 切深色（顶栏那颗月亮只在笔记视图里有 —— 编辑区一卸载它就没了，
   所以这一步必须留在笔记页里，不能等切到关系图之后再切） */
await shot({ dur: .8, cam: { on: '[title^="切到"]', k: 1.95 }, cursor: { on: '[title^="切到"]' }, ease: 'out', cap: CAP.dark })
await clickZoom('[title^="切到"]', { k: 2.05, dur: .55, cap: CAP.dark })
await sleep(500)
await shot({ dur: 1.0, cam: { x: 900, y: 460, k: 1.14 }, cursor: { x: 760, y: 500 }, ease: 'inout', cap: CAP.dark })
await evaluate(`document.documentElement.style.background = '#16161a'`)
await mark('dark')
await hold(.9, { cap: CAP.dark })

/* ⑧ 关系图：点侧栏 */
await shot({ dur: .9, cam: { x: 620, y: 300, k: 1.25 }, cursor: { x: 120, y: 420 }, ease: 'inout', cap: CAP.graph })
await clickZoom('.nav-item', { text: '关系图', k: 2.0, dur: .75, cap: CAP.graph })
await sleep(700)
/* 六个节点、九条连线围成一个网。推得太近只剩几个大圆点，推得太远又是一屏黑
   —— 2.4 倍左右，网刚好落在画面中间，周围留一圈底色。 */
await shot({ dur: 1.1, cam: { x: 1056, y: 452, k: 2.35 }, cursor: { x: 1090, y: 470 }, ease: 'inout', cap: CAP.graph })
await mark('graph')
await shot({ dur: 1.5, cam: { x: 1056, y: 448, k: 2.55 }, ease: 'inout', cap: CAP.graph })
await hold(.6, { cap: CAP.graph })

/* ⑧½ 思维导图：Ctrl+Shift+M 直接从关系图切过去（两个视图互斥，切换是干净的）。
   先把运镜收回全景 —— body 带着 2.5 倍 transform 时导图挂载，它自己 fit()
   算出来的相机是偏的，树会落在画面外；k≈1 时 fit 是准的，切过去直接推到树根。 */
await shot({ dur: .7, cam: { x: 1056, y: 450, k: 1.05 }, ease: 'inout', cap: CAP.graph })
await keyMod('m', 'KeyM', 77, 10) // Ctrl+Shift+M
await sleep(800)
/* 中景直接对准树根（固定坐标会踩空 —— fit 之后树落在哪要看它自己的算法） */
await shot({ dur: 1.0, cam: { on: '.mm-text', text: '一周手记', k: 1.45 }, cursor: { x: 800, y: 300 }, ease: 'inout', cap: CAP.map })
await mark('map')
await shot({ dur: 1.0, cam: { on: '.mm-text', text: '图表与表格', k: 2.2 }, ease: 'out', cap: CAP.map })
await mark('map-zoom')
await hold(1.1, { cap: CAP.map })
await keyMod('m', 'KeyM', 77, 10) // 切回关系图，别让便签镜头踩在导图上
await sleep(600)

/* ⑨ 便签墙（深色下铺开，纸色更跳） */
await clickZoom('.nav-item', { text: '便签', k: 2.0, dur: .7, cap: CAP.sticky })
await sleep(700)
/* 八张纸铺成三行。镜头贴着卡片网格走，但左边界卡在列表栏的分割线上 ——
   再往里一点就会切出半截字，再往外一点右边全是空桌面。 */
await shot({ dur: 1.0, cam: { x: 1134, y: 225, k: 1.5 }, cursor: { x: 940, y: 300 }, ease: 'inout', cap: CAP.sticky })
await mark('sticky')
await hold(1.2, { cap: CAP.sticky })

/* ⑩ 片尾 */
cursor = { x: -420, y: -420 }
await paintCursor({ x: -420, y: -420 }, false)
await shot({ dur: .9, cam: { x: W / 2, y: H / 2, k: 1.03 }, ease: 'inout', capOp: 0 })
const nEnd = Math.round(.7 * FPS)
for (let i = 1; i <= nEnd; i++) {
  await paintEnd(i / nEnd)
  await emit({ capOp: 0 })
}
for (let i = 0; i < Math.round(2.4 * FPS); i++) await emit({ capOp: 0 })
await mark('end')

if (!STILL) {
  await new Promise((r) => { ff.on('close', r); ff.stdin.end() })
  console.log('  成片 →', OUT, '｜', frameCount, '帧 /', T.toFixed(1), '秒')
} else {
  console.log('  关键帧出完，共', stillN, '张，虚拟时长', T.toFixed(1), 's')
}

await close()
process.exit(0)
