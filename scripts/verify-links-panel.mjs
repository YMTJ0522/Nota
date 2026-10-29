/**
 * 中间那栏「链接」：出链 / 反向链接两个方向都列对，且点得动。
 *
 * 为什么要真开一次应用：这一栏的数据一半来自当前正文（`state.draft`）、
 * 一半来自把工作区读一遍，中间隔着 IPC 与路径拼接。纯规则那部分已经在
 * `verify-links.mjs` 里钉住了，这里验的是「装到界面上还对不对」——
 * 用临时库（`NOTA_HOME`）跑，不碰真实数据。
 *
 * 用法：node scripts/verify-links-panel.mjs
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

const PORT = 9433
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-links-'))
const vault = path.join(HOME, 'documents', 'Nota')
fs.mkdirSync(vault, { recursive: true })
const w = (n, s) => {
  const p = path.join(vault, n)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s, 'utf8')
}

/* 一篇把所有写法都用上的正文。围栏里那句是**示例**，不该被算成链接 */
w(
  'reading.md',
  [
    '# 周记',
    '',
    '这周读了 [[读书笔记]]，顺手记在 [[日记/2026-10-01|周一的日记]] 里。',
    '',
    '还嵌入了 ![[摘录]]。',
    '',
    '```md',
    '链接写法：[[目标笔记]]',
    '```',
    '',
    '顺手记一句 [[还没建的那篇]]。',
    '',
  ].join('\n'),
)
w('读书笔记.md', '# 读书笔记\n\n关联 [[reading]]。\n')
w('摘录.md', '# 摘录\n\n> 一句话。\n')
w('other.md', '# 别的一篇\n\n这里提到 [[reading]] 两次：[[reading]]。\n')
w('日记/2026-10-01.md', '# 周一\n\n被 reading 引用了。\n')

const child = spawn(
  './node_modules/electron/dist/electron.exe',
  ['.', '--remote-debugging-port=' + PORT],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NOTA_HOME: HOME },
  },
)

const targets = async () => (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json())

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

  console.log('\n── 打开带双链的那一篇 ──')

  /* 列表里那几行是 button，按名字开 */
  const opened = await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const row = [...document.querySelectorAll('button')].find(b => /^reading/.test(b.textContent.trim()))
      if (!row) return 'no-row'
      row.click()
      await wait(2600)
      return 'ok'
    })()`,
  )
  ok('笔记列表里点得开 reading', opened === 'ok', opened)

  const tabs = await js(
    main,
    `JSON.stringify([...document.querySelectorAll('.col-tab')].map(t => ({ v: t.dataset.view, l: t.querySelector('.col-tab-label')?.textContent?.trim() })))`,
  )
  const tabList = JSON.parse(tabs || '[]')
  ok(
    '页签里有「链接」这一格（data-view=quote）',
    tabList.some((t) => t.v === 'quote' && t.l === '链接'),
    tabs,
  )

  const switched = await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      document.querySelector('.col-tab[data-view="quote"]')?.click()
      await wait(2600)
      return !!document.querySelector('.qv')
    })()`,
  )
  ok('切过去真出这一栏', switched === true, switched)

  console.log('\n── 两段的顺序与条数 ──')

  const panel = JSON.parse(
    (await js(
      main,
      `JSON.stringify({
        head: document.querySelector('.qv .pn-sub')?.textContent?.trim(),
        secs: [...document.querySelectorAll('.qv-sec')].map(s => s.querySelector('.qv-sec-t')?.textContent?.trim()),
        out: [...document.querySelectorAll('.qv-out')].map(b => ({
          name: b.querySelector('.qv-name-t')?.textContent,
          flag: b.querySelector('.qv-flag')?.textContent ?? null,
          folder: b.querySelector('.qv-folder')?.textContent,
          disabled: b.disabled,
          missing: b.classList.contains('missing'),
        })),
        back: [...document.querySelectorAll('.qv-back')].map(b => ({
          name: b.querySelector('.qv-name')?.textContent?.trim(),
          lines: b.querySelectorAll('.qv-line').length,
        })),
      })`,
    )) ?? '{}',
  )

  ok('反向链接在前、出链在后', (panel.secs ?? []).join(',') === '反向链接,出链', JSON.stringify(panel.secs))
  ok('顶栏计数写着「出 4 · 入 2」', panel.head === '出 4 · 入 2', panel.head)

  const back = panel.back ?? []
  ok('反向链接找到 2 篇（读书笔记 / other）', back.length === 2, JSON.stringify(back))
  ok(
    '反向链接按路径排序，两篇都摘出了命中的原文',
    back.map((b) => b.name).join(',') === '读书笔记,other' && back.every((b) => b.lines >= 1),
    JSON.stringify(back),
  )

  const out = panel.out ?? []
  ok('出链 4 条', out.length === 4, JSON.stringify(out.map((o) => o.name)))
  ok(
    '出链按正文出现顺序',
    out.map((o) => o.name).join(',') === '读书笔记,2026-10-01,摘录,还没建的那篇',
    out.map((o) => o.name).join(','),
  )
  ok(
    '围栏代码块里的 [[目标笔记]] 没被当成链接',
    !out.some((o) => o.name === '目标笔记'),
    out.map((o) => o.name).join(','),
  )
  ok(
    '别名记在「周一的日记」，篇名仍是 2026-10-01',
    out[1]?.name === '2026-10-01' && out[1]?.flag === '周一的日记',
    JSON.stringify(out[1]),
  )
  ok('嵌入那条标着「嵌入」', out[2]?.flag === '嵌入', JSON.stringify(out[2]))

  const missing = out[3] ?? {}
  ok(
    '指向不存在的笔记：标出来且不可点',
    missing.name === '还没建的那篇' && missing.disabled === true && missing.missing === true,
    JSON.stringify(missing),
  )

  console.log('\n── 点一下能不能跳过去 ──')

  /* 点过去以后，这一栏要跟着换成那一篇的链接关系 —— 这比看标题更能
     说明「真的换了笔记」：读书笔记 只指向 reading，而 reading 指向两篇 */
  const jumped = await js(
    main,
    `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const row = document.querySelectorAll('.qv-out')[0]
      if (!row) return 'no-row'
      row.click()
      await wait(2200)
      return JSON.stringify({
        head: document.querySelector('.qv .pn-sub')?.textContent?.trim(),
        out: [...document.querySelectorAll('.qv-out')].map(b => b.querySelector('.qv-name-t')?.textContent),
      })
    })()`,
  )
  let after = {}
  try {
    after = JSON.parse(jumped)
  } catch {
    after = {}
  }
  ok(
    '点出链第一条跳到「读书笔记」，这一栏跟着换成它的关系',
    after.head === '出 1 · 入 1' && (after.out ?? []).join(',') === 'reading',
    jumped,
  )
} catch (e) {
  fail.push('脚本中断')
  console.log('  FAIL  脚本中断：', e?.message ?? e)
} finally {
  try {
    child.kill()
  } catch {
    /* 已经退了 */
  }
  await sleep(900)
  try {
    fs.rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* 进程还没松手，留在临时目录里也无妨 */
  }
}

console.log(`\n${pass} 通过，${fail.length} 失败`)
if (fail.length) {
  console.log('失败项：')
  for (const f of fail) console.log('  ·', f)
  process.exit(1)
}
