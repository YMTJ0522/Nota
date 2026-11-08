import { launch } from './cdp-harness.mjs'
import { makeInject, makeNotes, makeTree, openNoteExpr } from './fake-workspace.mjs'

const PORT = 4413
const { send, evaluate, sleep, errors, close } = await launch({ port: PORT, size: [1500, 950] })

const NOTE = [
  '# 靶子',
  '',
  '正文一段。',
  '',
  '```ts',
  'export interface Note {',
  '  path: string',
  '  tags: string[]',
  '}',
  '```',
  '',
].join('\n')

const INJECT = makeInject({
  notes: { ...makeNotes(), '/ws/target.md': NOTE },
  tree: [...makeTree(), { type: 'file', name: 'target.md', path: '/ws/target.md', tags: [], starred: false, mtime: Date.now(), excerpt: '' }],
})

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
/* 新手引导的遮罩会盖住编辑区（.tour-block），点哪都点不到编辑器。
   它只在 localStorage 没有 nota-tour-seen 时弹，标一下再重载。 */
await evaluate(`localStorage.setItem('nota-tour-seen', '1')`)
await send('Page.reload', {})
await sleep(1400)
await evaluate(INJECT)
await evaluate(`document.querySelector('.cta')?.click()`)
await sleep(1200)
await evaluate(INJECT)
await sleep(700)
await evaluate(`document.querySelector('.col-tab[data-view="notes"]')?.click()`)
await sleep(400)
await evaluate(openNoteExpr('target'))
await sleep(1500)
await evaluate(`document.querySelector('.ph-seg-btn[aria-label^="编辑模式"]')?.click()`)
await sleep(900)

console.log('lines:', await evaluate(`JSON.stringify([...document.querySelectorAll('.cm-line')].map(e=>e.textContent))`))

const p = JSON.parse(await evaluate(`
  (() => { var ls=[...document.querySelectorAll('.cm-line')];
    var el=ls.find(e=>(e.textContent||'').trim()==='path: string');
    if(!el) return 'null';
    var b=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(b.x+12),y:Math.round(b.y+b.height/2), left:Math.round(b.x)}); })()
`) || '{}')
console.log('click point', p)

console.log('elementFromPoint:', await evaluate(`
  (() => { var el = document.elementFromPoint(${p.x}, ${p.y});
    return el ? el.className + ' | ' + el.tagName : 'none'; })()
`))
console.log('viewport:', await evaluate(`JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})`))

console.log('elementFromPoint:', await evaluate(`
  (() => { var el = document.elementFromPoint(${p.x}, ${p.y});
    return el ? el.className + ' | ' + el.tagName : 'none'; })()
`))
console.log('viewport:', await evaluate(`JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})`))

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
await sleep(500)

console.log(await evaluate(`
  (() => {
    var v = window.__notaView; if (!v) return 'no view';
    var st = v.state; var head = st.selection.main.head;
    var line = st.doc.lineAt(head);
    var names = []; var node = st.tree ? null : null;
    var t = window.__notaTree || null;
    return JSON.stringify({
      focus: document.activeElement && document.activeElement.className,
      head, lineNo: line.number, lineText: line.text,
    });
  })()
`))

console.log('tree walk:', await evaluate(`
  (() => {
    var v = window.__notaView;
    var head = v.state.selection.main.head;
    // 复用应用里的 @codemirror/language 拿不到，只能从 DOM 侧看：改用 view.state.field?
    var out = [];
    var sel = document.querySelector('.cm-selectionBackground');
    return JSON.stringify({ hasSelLayer: !!sel, activeLine: (document.querySelector('.cm-activeLine')||{}).textContent });
  })()
`))

console.log('errors', errors.slice(0, 4))
await close()
