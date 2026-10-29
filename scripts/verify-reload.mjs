/**
 * 「重新读取工作区」：外部改了盘，界面能不能知道。
 *
 * 这件事没法只测函数：它一半在 store（重读树、比 mtime、比对正文），
 * 一半在窗口上（焦点事件、命令面板入口、toast 说了什么）。
 * 所以真开一次应用，用临时库（`NOTA_HOME`）跑，不碰真实数据。
 *
 * 四个场景，每个都对应一条会被用户骂的具体情况：
 *   1. 资源管理器里新建的笔记，命令面板里那条命令按下去要出现；
 *   2. 外部改了**当前这篇**、且正文干净 → 编辑区跟着更新；
 *   3. 外部改了当前这篇、而用户手上有没保存的字 → **不许覆盖**，只提示；
 *   4. 切回窗口（焦点）就自动刷，不用记快捷键。
 *
 * 用法：node scripts/verify-reload.mjs
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

const PORT = 9446
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-reload-'))
const vault = path.join(HOME, 'documents', 'Nota')
fs.mkdirSync(vault, { recursive: true })
const w = (n, s) => fs.writeFileSync(path.join(vault, n), s, 'utf8')

/** 写完再确认读得回来、且让元数据落一下 —— 紧接着就让应用去读，别输给自己 */
const writeSettled = async (n, s) => {
  w(n, s)
  for (let i = 0; i < 20; i++) {
    if (fs.readFileSync(path.join(vault, n), 'utf8') === s) break
    await sleep(20)
  }
  await sleep(80)
}

w('甲.md', '# 甲\n\n最初的正文。\n')
w('乙.md', '# 乙\n\n提到 [[甲]]。\n')

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', '--remote-debugging-port=' + PORT], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NOTA_HOME: HOME },
})

const targets = async () => await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()

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

/** 侧栏树里所有文件名 */
const treeNames = (c) =>
  js(c, `JSON.stringify([...document.querySelectorAll('.row.file .name')].map(n => n.textContent.trim()))`).then(
    (s) => JSON.parse(s || '[]'),
  )

/** 最近一条 toast 的文字；没有就空串 */
const lastToast = (c) =>
  js(c, `(document.querySelector('.toast .toast-text')?.textContent ?? '').trim()`)

/** 点开命令面板、搜一条命令、点它 */
async function runCmd(c, kw) {
  await js(
    c,
    `(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      return true
    })()`,
  )
  await sleep(260)
  const typed = await js(
    c,
    `(() => {
      const el = document.querySelector('.cp-input')
      if (!el) return 'no-input'
      el.value = ${JSON.stringify(kw)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`,
  )
  if (typed !== 'ok') return typed
  await sleep(200)
  const titles = JSON.parse(
    (await js(c, `JSON.stringify([...document.querySelectorAll('.cp-row .cp-title')].map(t => t.textContent.trim()))`)) ??
      '[]',
  )
  const hit = titles.find((t) => t === '重新读取工作区')
  if (!hit) return 'no-row:' + titles.slice(0, 4).join(',')
  const clicked = await js(
    c,
    `(() => {
      const row = [...document.querySelectorAll('.cp-row')].find(r => r.querySelector('.cp-title')?.textContent.trim() === '重新读取工作区')
      if (!row) return 'no-row'
      row.click()
      return 'ok'
    })()`,
  )
  return clicked
}

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
  for (let i = 0; i < 60; i++) {
    if ((await js(main, 'typeof window.api')) === 'object') break
    await sleep(300)
  }
  await sleep(3000)

  console.log('\n── 先确认起点：两篇都在 ──')
  const start = await treeNames(main)
  ok('侧栏读到 甲 / 乙', start.includes('甲') && start.includes('乙'), JSON.stringify(start))

  console.log('\n── 1. 外部新建一篇，命令面板里那条命令要能把它带出来 ──')
  await writeSettled('丙.md', '# 丙\n\n在资源管理器里新建的。\n')
  const r1 = await runCmd(main, '重新读取')
  ok('命令面板里搜得到「重新读取工作区」并点得下去', r1 === 'ok', r1)
  await sleep(900)
  const afterAdd = await treeNames(main)
  ok('侧栏出现了外部新建的「丙」', afterAdd.includes('丙'), JSON.stringify(afterAdd))
  const t1 = await lastToast(main)
  ok('提示说了「多了 1 篇」', /多了 1 篇/.test(t1), t1)

  console.log('\n── 2. 外部改当前这篇（正文干净）→ 编辑区跟着更新 ──')
  await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const row = [...document.querySelectorAll('.row.file')].find(b => b.querySelector('.name')?.textContent.trim() === '甲')
      row?.click()
      await wait(1200)
      document.querySelector('.cm-content')?.focus()
      return true
    })()`,
  )
  await sleep(1200)
  const before = await js(main, `document.querySelector('.cm-content')?.textContent ?? ''`)
  ok('先打开的是甲（第一条正文对）', /最初的正文/.test(before || ''), JSON.stringify(before))

  await sleep(4200) // 越过 4 秒的焦点节流，后面那条 focus 才不会被吃掉
  await writeSettled('甲.md', '# 甲\n\n外部改写过的正文。\n')
  await js(main, `(window.dispatchEvent(new Event('focus')), true)`)
  await sleep(1400)
  const afterDisk = await js(main, `document.querySelector('.cm-content')?.textContent ?? ''`)
  ok('编辑区换成了磁盘上的新正文', /外部改写过的正文/.test(afterDisk || ''), JSON.stringify(afterDisk))
  const t2 = await lastToast(main)
  ok('提示说了「按磁盘上的版本更新」', /按磁盘上的版本更新/.test(t2), t2)

  console.log('\n── 3. 有未保存内容时，外部改动不许覆盖 ──')
  await sleep(4200)
  // 先把正文改成「有未保存内容」：打字之后自动保存要 600ms，这里故意不等它
  await js(main, `(document.querySelector('.cm-content')?.focus(), true)`)
  await main.send('Input.insertText', { text: '我刚敲的字' })
  await sleep(120)
  await writeSettled('甲.md', '# 甲\n\n另一份外部版本。\n')
  await js(main, `(window.dispatchEvent(new Event('focus')), true)`)
  await sleep(1200)
  const kept = await js(main, `document.querySelector('.cm-content')?.textContent ?? ''`)
  ok('手打的那几个字还在（没被替换）', /我刚敲的字/.test(kept || ''), JSON.stringify(kept))
  ok('也没有把外部那份塞进来', !/另一份外部版本/.test(kept || ''), JSON.stringify(kept))
  const t3 = await lastToast(main)
  ok('提示说了「没覆盖」', /没覆盖/.test(t3), t3)

  console.log('\n── 3b. 自己手上有没保存的字，不该被当成「外面有人改」 ──')
  await sleep(4200)
  await js(main, `(document.querySelector('.toasts')?.replaceChildren(), document.querySelector('.cm-content')?.focus(), true)`)
  await main.send('Input.insertText', { text: '又敲一句' })
  await sleep(120)
  await js(main, `(window.dispatchEvent(new Event('focus')), true)`)
  await sleep(1000)
  const t4 = await lastToast(main)
  ok('盘上没人动过，就不该弹「没覆盖」', t4 === '', JSON.stringify(t4))
  const stillThere = await js(main, `document.querySelector('.cm-content')?.textContent ?? ''`)
  ok('自己敲的字也还在', /又敲一句/.test(stillThere || ''), JSON.stringify(stillThere))

  console.log('\n── 4. 切回窗口（焦点）自己就刷，不用记快捷键 ──')
  await sleep(4200)
  await writeSettled('丁.md', '# 丁\n\n切窗口之前放进去的。\n')
  await js(main, `(window.dispatchEvent(new Event('focus')), true)`)
  await sleep(1600)
  const afterFocus = await treeNames(main)
  ok('没按任何命令，侧栏就出现了「丁」', afterFocus.includes('丁'), JSON.stringify(afterFocus))

  console.log('\n── 5. 什么都没变时不该吵 ──')
  await sleep(4200)
  await js(main, `(document.querySelector('.toasts')?.replaceChildren(), window.dispatchEvent(new Event('focus')), true)`)
  await sleep(1200)
  const quiet = await lastToast(main)
  ok('没变化就不弹提示（安静模式）', quiet === '', JSON.stringify(quiet))
} finally {
  try {
    main?.ws?.close()
  } catch {
    /* ignore */
  }
  child.kill()
  await sleep(400)
  try {
    fs.rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* Windows 上偶尔还被占着，留给系统清理 */
  }
}

console.log(`\n${pass} 通过 / ${fail.length} 失败`)
if (fail.length) {
  console.log('失败项：\n  · ' + fail.join('\n  · '))
  process.exitCode = 1
}
