/**
 * 代码块内的文字选中：底色卡片（::before, z -2）必须沉到选区层（z -1）下面，
 * 选中高亮才看得见。computed style 永远「正确」，这类层叠 bug 只能靠像素作证：
 * 双击代码块里的一个词 → 截图 → 取选区中心的实际像素 → 和卡片底色比。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4431)
const OUT = '.tmp-shots'
const { send, evaluate, sleep, shot, errors, close } = await launch({ port: PORT, size: [1500, 960], scale: 2 })

const SAMPLE = [
  '# 一周手记',
  '',
  '```bash line-numbers {2-4}',
  '# 查看系统信息',
  'uname -a',
  'cat /etc/os-release',
  'hostname',
  'uptime',
  '```',
].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/一周手记.md': SAMPLE },
  tree: [...makeTree(), { type: 'file', name: '一周手记.md', path: '/ws/一周手记.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
})

let bad = 0
function ok(name, cond, extra = '') {
  if (cond) console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`)
  else {
    bad += 1
    console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
await evaluate(`localStorage.setItem('nota-tour-seen','1')`)
await evaluate(`location.reload()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(600)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(900)
await evaluate(INJECT)
await sleep(600)
await evaluate(openNoteExpr('一周手记'))
await sleep(1100)
await evaluate(`document.documentElement.setAttribute('data-theme','dark')`)
await sleep(500)

// 双击代码块里的 hostname 选中它
const word = JSON.parse(
  await evaluate(`
    (() => {
      var ls = [...document.querySelectorAll('.cm-line')];
      var el = ls.find((e) => (e.textContent || '').includes('hostname') && e.closest('.cm-md-codeblock'));
      if (!el) return 'null';
      var b = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + 30), y: Math.round(b.y + b.height / 2) });
    })()
  `),
)
ok('找到代码块里的目标行', !!word)

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: word.x, y: word.y, button: 'left', clickCount: 2 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: word.x, y: word.y, button: 'left', clickCount: 2 })
await sleep(500)

const sel = JSON.parse(
  await evaluate(`
    (() => {
      var bg = document.querySelector('.cm-selectionBackground');
      if (!bg) return JSON.stringify({ has: false });
      var r = bg.getBoundingClientRect();
      return JSON.stringify({ has: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()
  `),
)
ok('选区层存在', sel.has === true)

await shot(`${OUT}/sel-in-codeblock.png`)

// 选区中心像素 vs 卡片底色像素（同一行未选中的远处）
if (sel.has) {
  const cardPx = await evaluate(`
    (() => {
      var cs = getComputedStyle(document.documentElement);
      return cs.getPropertyValue('--n-code-surface').trim();
    })()
  `)
  console.log(`   卡片底色 token: ${cardPx}`)
  const py = `from PIL import Image
im = Image.open('${OUT}/sel-in-codeblock.png').convert('RGB')
s = im.getpixel((${sel.x * 2}, ${sel.y * 2}))
u = im.getpixel((${(sel.x + 120) * 2}, ${sel.y * 2}))
print(s, u)
diff = sum(abs(a - b) for a, b in zip(s, u))
print('DIFF', diff)
`
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${OUT}/px.py`, py)
  const { execSync } = await import('node:child_process')
  const out = execSync(`py ${OUT}/px.py`, { encoding: 'utf8' })
  console.log('   选区像素 / 未选像素:', out.trim().replace(/\n/g, ' | '))
  const diff = Number(/DIFF (\d+)/.exec(out)?.[1] ?? 0)
  ok('选区在代码块里可见（与底色差异明显）', diff > 30, `像素差 ${diff}`)
}

console.log(`\n通过 ${bad === 0 ? '全部' : '部分'}，失败 ${bad} 项`)
await close()
process.exit(bad ? 1 : 0)
