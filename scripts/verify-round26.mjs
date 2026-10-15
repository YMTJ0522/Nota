/**
 * round26：Word 导出修复的两条断言（2.6.x）。
 *  · 代码块每一行从 `<span class="pv-line">`（靠 CSS display:block 撑行，
 *    Word/WPS 不认 → 整块糊成一行）换成真块级 `<p>`；
 *  · 图片（mermaid 光栅图为主）钉死像素 width/height —— Word 不认
 *    max-width，2 倍图按原始像素排版会铺满两页。
 * 断言都页内做，免得把几百 KB 的 base64 拖回 node。
 * `SAVE_DOC=路径` 时顺带落一份真实 .doc 成品，可用 WPS 直接开。
 */
import { launch } from './cdp-harness.mjs'
import { makeInject } from './fake-workspace.mjs'

const NOTE = [
  '# 导出体检',
  '',
  '> [!warning] 注意',
  '> 这一块要变成带色边的表格。',
  '',
  '```bash title="deploy.sh" line-numbers',
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'RSYNC_OPTS="-avz --delete"',
  'rsync $RSYNC_OPTS ./dist/ user@server:/srv/app',
  'echo "部署完成"',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  A[提交] --> B{测试通过?}',
  '  B -- 是 --> C[部署]',
  '  B -- 否 --> D[修]',
  '```',
  '',
  '- [x] 写完脚本',
  '- [ ] 挂上 cron',
].join('\n')

const { send, evaluate, sleep, close } = await launch({ port: 4468, size: [1500, 940] })
const notes = { '/ws/导出体检.md': NOTE }
const TREE = [
  {
    type: 'file',
    name: '导出体检.md',
    path: '/ws/导出体检.md',
    tags: [],
    starred: false,
    mtime: Date.now(),
    excerpt: '',
  },
]
const INJECT = makeInject({ notes, tree: TREE })

await send('Page.navigate', { url: 'http://127.0.0.1:4468/' })
await sleep(1200)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(900)
await evaluate(`
  (() => {
    const r = [...document.querySelectorAll('.nlist .nl-item')].find(b => (b.textContent||'').includes('导出体检'))
    r?.click()
    return !!r
  })()
`)
await sleep(1600)

const r = await evaluate(`(async () => {
  const dbg = {
    active: document.querySelector('.topbar-title, [data-role]') ? 1 : 0,
    anchors: [...document.querySelectorAll('.ea-anchor')].length,
    editor: !!document.querySelector('.cm-editor'),
    nlItems: document.querySelectorAll('.nlist .nl-item').length,
  }
  const menuBtn = document.querySelector('.hm-anchor')
  if (!menuBtn) return { fail: 'no menu btn', dbg }
  menuBtn.click()
  await new Promise(r => setTimeout(r, 260))
  const items = [...document.querySelectorAll('.hm-menu .hm-item')]
  const word = items.find(b => b.textContent.includes('Word'))
  if (!word) return { fail: 'no word item', items: items.map(i => i.textContent.trim()) }
  word.click()
  await new Promise(r => setTimeout(r, 2500))
  const data = window.__exportedData?.word
  if (!data) return { fail: 'no data' }
  const codePs = (data.match(/<p style="margin:0;/g) || []).length
  return {
    kind: window.__exported?.includes('word'),
    name: true,
    noPvLine: !data.includes('class="pv-line"'),
    codePs,
    hasWcCode: data.includes('wc-code'),
    hasWcCallout: data.includes('wc-callout'),
    imgWidth: (data.match(/<img [^>]*width="/g) || []).length,
    imgStyleW: (data.match(/width:\\d+px;height:\\d+px/g) || []).length,
    hasMermaidImg: data.includes('data:image/png'),
    nbspEmptyLine: data.includes('&nbsp;') || data.includes('\\u00A0'),
    taskChar: data.includes('☒') && data.includes('☐'),
    bigImgGone: !data.match(/width="(1[5-9]\\d\\d|2\\d{3})"/),
  }
})()`)
console.log(JSON.stringify(r, null, 2))

/* 落一份真实成品，直接拿 WPS 开 */
const data = await evaluate(`window.__exportedData?.word || ''`)
if (process.env.SAVE_DOC && data) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.SAVE_DOC, Buffer.from(data, 'utf8'))
  console.log('saved →', process.env.SAVE_DOC)
}

const bad = r.fail || !r.noPvLine || !r.codePs || !r.hasWcCode || !r.hasWcCallout ||
  !r.imgWidth || !r.hasMermaidImg || !r.taskChar || !r.bigImgGone
console.log(bad ? 'ROUND26 FAIL' : 'ROUND26 PASS')
await close()
process.exit(0)
