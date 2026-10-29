/**
 * 便签多选：资料栏里勾了哪几张，右边那面墙上得看得出来。
 *
 * 这一条修的是用户报的：中栏（资料栏）多选时每一行都有绿勾，可右边便签墙上
 * 十几张纸长得一模一样 —— 挑完回头看，根本不知道挑的是哪几张。
 *
 * 判据：
 *  · 不在选择模式时，墙上不长勾（常驻勾选框会让纸不像纸）；
 *  · 进了选择模式，每张纸角上一枚圈；勾中的那几张再套一圈强调色；
 *  · 墙上点一下也能加选/取消（和左列同一个语义）；
 *  · 点「完成」两边一起收干净；离开这一屏再回来不能留着上次的勾。
 *
 * 用法：node scripts/verify-sticky-pick.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

let pass = 0
const fail = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail.push(name)
    console.log(`  FAIL  ${name}  ${detail ?? ''}`)
  }
}

const PORT = 9462
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-pick-'))
const vault = path.join(HOME, 'documents', 'Nota')
const dir = path.join(vault, '.nota', 'stickies')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(vault, 'a.md'), '# 甲\n\n', 'utf8')

const now = Date.now()
const seed = ['买牛奶', '记住一个域名', '第三张便签']
fs.writeFileSync(
  path.join(dir, 'index.json'),
  JSON.stringify(
    seed.map((_, i) => ({
      id: 'p' + (i + 1),
      createdAt: now - i * 1000,
      updatedAt: now - i * 1000,
      color: ['amber', 'sky', 'rose'][i],
    })),
    null,
    2,
  ),
  'utf8',
)
seed.forEach((t, i) => fs.writeFileSync(path.join(dir, `p${i + 1}.md`), `${t}\n随手记\n`, 'utf8'))

const child = spawn(
  './node_modules/electron/dist/electron.exe',
  ['.', '--remote-debugging-port=' + PORT],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NOTA_HOME: HOME } },
)

const targets = async () => (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json())
const errors = []

function attach(u) {
  return new Promise((res) => {
    const ws = new WebSocket(u)
    let s = 0
    const p = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && p.has(m.id)) {
        p.get(m.id)(m)
        p.delete(m.id)
      } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
      }
    }
    ws.onopen = () =>
      res({
        ws,
        send: (method, params) =>
          new Promise((r) => {
            const id = ++s
            p.set(id, r)
            ws.send(JSON.stringify({ id, method, params }))
          }),
      })
  })
}

const js = async (c, e) => {
  const r = await c.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.result?.value
}

const state = () =>
  js(
    main,
    `JSON.stringify({
      badges: document.querySelectorAll('.sb-pick').length,
      onCards: document.querySelectorAll('.sb-card.on').length,
      ring: [...document.querySelectorAll('.sb-card.on')].every((c) => (c.style.boxShadow || '').includes('--n-accent')),
      head: document.querySelector('.sb-n')?.textContent?.trim(),
      rows: document.querySelectorAll('.sv-item.sel').length,
      pickMode: document.querySelectorAll('.sb-card.pick').length,
    })`,
  )

let main = null
try {
  let page = null
  for (let i = 0; i < 120; i++) {
    try {
      page = (await targets()).find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (page) break
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  if (!page) throw new Error('没等到窗口起来')
  main = await attach(page.webSocketDebuggerUrl)
  await main.send('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    if ((await js(main, 'typeof window.api')) === 'object') break
    await sleep(300)
  }
  await sleep(2800)

  await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('便签'))
      b && b.click()
      await wait(1600)
      const more = document.querySelector('.sv-more')
      if (more && !more.classList.contains('open')) more.click()
      await wait(500)
      return 1
    })()`,
  )

  const cards = await js(main, `document.querySelectorAll('.sb-card').length`)
  ok('墙上有三张纸', cards === 3, String(cards))

  let s0 = JSON.parse(await state())
  ok('平时墙上不长勾', s0.badges === 0 && s0.pickMode === 0, JSON.stringify(s0))
  ok('顶栏是张数那一句', /3 张/.test(s0.head ?? ''), String(s0.head))

  /* 进选择模式：左列顶上那颗「多选」 */
  const entered = await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const b = [...document.querySelectorAll('button')].find((x) => /批量选择|多选/.test(x.title || x.getAttribute('data-tip') || ''))
      if (!b) return 'no-btn'
      b.click()
      await wait(500)
      return 'ok'
    })()`,
  )
  ok('左列能找到「多选」这一颗', entered === 'ok', entered)

  let s1 = JSON.parse(await state())
  ok('进了选择模式，每张纸角上都长出一枚圈', s1.badges === 3 && s1.pickMode === 3, JSON.stringify(s1))
  ok('还没挑，所以没有一张是「选中」态', s1.onCards === 0, JSON.stringify(s1))

  /* 在左列勾两张 */
  await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const rows = [...document.querySelectorAll('.sv-item')]
      rows[0] && rows[0].click()
      await wait(150)
      rows[1] && rows[1].click()
      await wait(400)
      return 1
    })()`,
  )

  let s2 = JSON.parse(await state())
  ok('左列勾了两行', s2.rows === 2, JSON.stringify(s2))
  ok('墙上跟着选中两张', s2.onCards === 2, JSON.stringify(s2))
  ok('选中的那两张纸外面套了强调色描边', s2.ring === true, JSON.stringify(s2))
  ok('顶栏改成「已选 2 / 3」', s2.head === '已选 2 / 3', String(s2.head))

  /* 墙上点第三张：加选；再点一次：取消 */
  const toggle = await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const card = [...document.querySelectorAll('.sb-card')].find((c) => !c.classList.contains('on'))
      card.click()
      await wait(350)
      const one = document.querySelectorAll('.sb-card.on').length
      card.click()
      await wait(350)
      return JSON.stringify({ after: one, back: document.querySelectorAll('.sb-card.on').length, head: document.querySelector('.sb-n')?.textContent?.trim() })
    })()`,
  )
  const t = JSON.parse(toggle ?? '{}')
  ok('墙上点一下就能加选', t.after === 3, toggle)
  ok('再点一下取消', t.back === 2, toggle)
  ok('顶栏计数跟着走', t.head === '已选 2 / 3', String(t.head))

  /* 完成 → 两边一起清 */
  await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '完成')
      if (b) b.click()
      await wait(500)
      return !!b
    })()`,
  )
  let s3 = JSON.parse(await state())
  ok('点「完成」之后墙上不再长勾', s3.badges === 0 && s3.pickMode === 0, JSON.stringify(s3))
  ok('顶栏回到张数', /3 张/.test(s3.head ?? ''), String(s3.head))

  /* 换一屏再回来：不能留着上次的勾 */
  await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('所有笔记'))
      b && b.click()
      await wait(700)
      const c = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('便签'))
      c && c.click()
      await wait(1200)
      return 1
    })()`,
  )
  let s4 = JSON.parse(await state())
  ok('离开再回来，墙上还是干净的', s4.badges === 0 && s4.pickMode === 0, JSON.stringify(s4))

  ok('没有脚本报错', errors.length === 0, JSON.stringify(errors).slice(0, 300))
} catch (e) {
  fail.push('跑挂了')
  console.log('  FAIL  跑挂了  ' + (e?.message ?? e))
} finally {
  child.kill()
  await sleep(500)
  try {
    fs.rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* 被占用就算了 */
  }
}

console.log(`\n${pass} 通过 / ${fail.length} 失败`)
if (fail.length) {
  console.log(fail.join(' / '))
  process.exit(1)
}
