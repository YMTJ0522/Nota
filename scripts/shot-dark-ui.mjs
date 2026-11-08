/**
 * 深色下的两处视觉验证（截图脚本，只看不断言）：
 *   1. 代码块卡片 + 标行高亮：底色要铺满整行到边，圆角只出现在首末行；
 *   2. 思维导图：静止状态下文字要锐（will-change 只在手势中开）。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = Number(process.env.PORT || 4417)
const OUT = '.tmp-shots'
const { send, evaluate, sleep, shot, errors, close } = await launch({ port: PORT, size: [1500, 960], scale: 2 })

const SAMPLE = [
  '# 一周手记',
  '',
  '## 这周做了什么 #记录',
  '',
  '- 把周报模板定下来',
  '  - 去掉三段套话，只留「做了什么 / 卡在哪 / 下周」',
  '  - 试写了两期，字数从 800 降到 300',
  '- 整理读书笔记三篇',
  '  - 《设计中的设计》',
  '',
  '## 卡住的地方 #问题',
  '',
  '- 图表在窄屏会溢出',
  '- 深色下导图发虚',
  '',
  '## 下周',
  '',
  '- [ ] 把备份脚本挪到 cron',
  '- [x] 清一遍旧稿',
  '',
  '## 命令速查',
  '',
  '前面一段正文。',
  '',
  '```bash line-numbers {2-4}',
  '# 查看系统信息',
  'uname -a',
  'cat /etc/os-release',
  'hostname',
  'uptime',
  '```',
  '',
  '中间一段正文。',
  '',
  '```ts',
  'export interface Note {',
  '  path: string',
  '}',
  '```',
  '',
  '结尾一段。',
].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/一周手记.md': SAMPLE },
  tree: [
    ...makeTree(),
    { type: 'file', name: '一周手记.md', path: '/ws/一周手记.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' },
  ],
})

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

/* 深色 + 滚到第一个代码块 */
await evaluate(`document.documentElement.setAttribute('data-theme','dark')`)
await sleep(500)
await evaluate(`
  (() => {
    var el = [...document.querySelectorAll('.cm-line')].find(e => (e.textContent || '').includes('uname'));
    el?.scrollIntoView({ block: 'center' });
  })()
`)
await sleep(600)
await shot(`${OUT}/dark-codeblock.png`)

/* 预览侧同一块（高亮应该同一种色） */
await evaluate(`
  (() => {
    var el = [...document.querySelectorAll('.pv-line.is-hl')][0];
    el?.scrollIntoView({ block: 'center' });
  })()
`)
await sleep(600)
await shot(`${OUT}/dark-preview-code.png`)

/* 导图（静止状态截图，看文字锐不锐）：先切到大纲页签，再点头部的导图按钮 */
await evaluate(`document.querySelector('.col-tab[data-view="outline"]')?.click()`)
await sleep(700)
await evaluate(`document.querySelector('.ov .pn-x[aria-label="打开思维导图"]')?.click()`)
await sleep(1400)
await shot(`${OUT}/dark-map-crisp.png`)

console.log('控制台异常:', errors.length ? errors.slice(0, 6) : '无')
await close()
