/**
 * 预览区点待办的勾：勾对了那一行、而且不整篇重排。
 *
 * 这一条修的是两个观感问题（用户报的）：
 *  ① 点了以后勾「闪一下」—— 原来预览 180ms 后整篇重排，<ul> 被拆了重建，
 *     刚画上的勾要重画一遍；
 *  ② 「闪出一个删除的东西」—— 删除线是立刻画上的（text-decoration 没法过渡），
 *     底色却在淡入，中间那百来毫秒就是「划掉了但还没勾上」。
 *
 * 判据分三层：
 *  · 画面上：点下去的第一帧里勾和填充都到位（读 computed style，不靠肉眼）；
 *  · DOM 上：点之前抓住那个 span，点完 600ms 它还在文档里（说明没重排）；
 *  · 语义上：改的是**对的那一行** —— 引用块里的、注释里的、代码块里的
 *    都不能让序号错位（这是原实现真错了的地方，点第二条勾掉第三条）。
 *
 * 用法：node scripts/verify-task-toggle.mjs
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

const PORT = 9461
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-task-'))
const vault = path.join(HOME, 'documents', 'Nota')
fs.mkdirSync(vault, { recursive: true })
const NOTE = path.join(vault, 'tasks.md')

/* 四种待办混在一起，序号必须一一对上：
   普通 / 引用块里 / 注释里（预览看不到）/ 代码块里（只是示例） */
const body = [
  '# 待办',
  '',
  '- [ ] 一 买牛奶',
  '',
  '> - [ ] 二 引用里的一条',
  '',
  '- [ ] 三 回邮件',
  '',
  '%%',
  '- [ ] 隐藏的那条（预览里没有）',
  '%%',
  '',
  '```md',
  '- [ ] 代码块里的示例',
  '```',
  '',
  '1. [ ] 四 有序列表',
  '',
].join('\n')
fs.writeFileSync(NOTE, body, 'utf8')

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

const read = () => fs.readFileSync(NOTE, 'utf8')

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
  const main = await attach(page.webSocketDebuggerUrl)
  await main.send('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    if ((await js(main, 'typeof window.api')) === 'object') break
    await sleep(300)
  }
  await sleep(3000)

  const opened = await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const row = [...document.querySelectorAll('button')].find(b => /tasks/.test(b.textContent))
      if (!row) return 'no-row'
      row.click()
      await wait(2000)
      const split = document.querySelector('button[aria-label^="分栏"]')
      if (split) split.click()
      await wait(1200)
      return document.querySelectorAll('.preview .pv-task').length
    })()`,
  )
  ok('预览里只长出 4 个勾（注释里的、代码块里的不算）', opened === 4, String(opened))

  const labels = JSON.parse(
    (await js(
      main,
      `JSON.stringify([...document.querySelectorAll('.preview .pv-task')].map(t => t.parentElement.textContent.trim()))`,
    )) ?? '[]',
  )
  ok(
    '四个勾依次是一 / 二 / 三 / 四',
    labels.join('|') === '一 买牛奶|二 引用里的一条|三 回邮件|四 有序列表',
    JSON.stringify(labels),
  )

  /** 点第 n 个勾，并收集点下去那一帧的状态 */
  async function clickTask(idx) {
    return JSON.parse(
      (await js(
        main,
        `(async () => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms))
          const el = document.querySelector('.preview .pv-task[data-task="${idx}"]')
          if (!el) return JSON.stringify({ err: 'no-el' })
          el.scrollIntoView({ block: 'center' })
          await wait(200)
          const b = el.getBoundingClientRect()
          window.__el = el
          return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })
        })()`,
      )) ?? '{}',
    )
  }

  /* ── 1. 点第二条（引用块里那条）── */
  const p1 = await clickTask(1)
  await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
  await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
  await sleep(60)

  const frame = JSON.parse(
    (await js(
      main,
      `(() => {
        const el = document.querySelector('.preview .pv-task[data-task="1"]')
        const s = getComputedStyle(el)
        const after = getComputedStyle(el, '::after')
        return JSON.stringify({
          on: el.classList.contains('on'),
          bg: s.backgroundColor,
          border: s.borderTopColor,
          tick: after.opacity,
          struck: getComputedStyle(el.parentElement).textDecorationLine,
        })
      })()`,
    )) ?? '{}',
  )
  ok('点下去就带上了 on', frame.on === true, JSON.stringify(frame))
  ok(
    '底色一帧内到位（不是从透明淡进来的）',
    !!frame.bg && frame.bg !== 'rgba(0, 0, 0, 0)' && frame.bg !== 'transparent' && !/\/\s*0(\.0+)?\)$/.test(frame.bg),
    String(frame.bg),
  )
  ok('勾在第一帧就画出来了（不再淡入）', frame.tick === '1', String(frame.tick))
  ok('那一行同一帧就划上了删除线', /line-through/.test(frame.struck ?? ''), String(frame.struck))

  /* 自动保存是防抖的，读盘要等它落下来；DOM 那几条不用等 */
  await sleep(1000)
  const alive = await js(main, `(document.contains(window.__el) && window.__el.classList.contains('on'))`)
  ok('一秒后还是同一个 DOM 节点（说明没有整篇重排）', alive === true, String(alive))

  const text1 = read()
  ok('改的是引用块里那一行', /^> - \[x\] 二 引用里的一条$/m.test(text1), text1)
  ok('第三条没被连累', /^- \[ \] 三 回邮件$/m.test(text1), text1)

  /* ── 2. 撤销：源码回去，预览也跟着回去 ── */
  await js(main, `(document.querySelector('.cm-content')?.focus(), true)`)
  await main.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
  await main.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
  await sleep(900)
  ok('撤销后源码回到 [ ]', /^> - \[ \] 二 引用里的一条$/m.test(read()), read())
  const afterUndo = await js(main, `document.querySelectorAll('.preview .pv-task.on').length`)
  ok('撤销后预览里的勾也没了（这一类改动照常重排）', afterUndo === 0, String(afterUndo))

  /* ── 3. 第三个勾（普通行）与第四个（有序列表）── */
  for (const [idx, line] of [
    [2, /^- \[x\] 三 回邮件$/m],
    [3, /^1\. \[x\] 四 有序列表$/m],
  ]) {
    const p = await clickTask(idx)
    await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(700)
    ok(`第 ${idx + 1} 个勾改对了它自己那一行`, line.test(read()), read())
  }

  ok('注释里那条始终没被改', /^- \[ \] 隐藏的那条（预览里没有）$/m.test(read()), read())
  ok('代码块里的示例始终没被改', /^- \[ \] 代码块里的示例$/m.test(read()), read())

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
