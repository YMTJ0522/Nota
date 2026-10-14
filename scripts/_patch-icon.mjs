/**
 * 一次性替换脚本：把启动页与关于页的描边 SVG 标换成应用图标本身。
 * 用完即删（临时补丁，不进版本库）。
 */
import fs from 'fs'

const enc = 'utf8'

function patch(file, fn) {
  const s = fs.readFileSync(file, enc)
  const out = fn(s)
  if (out === s) {
    console.log(`!! ${file} 没改动`)
    return
  }
  fs.writeFileSync(file, out, enc)
  console.log(`ok ${file}`)
}

/* ── 1. 启动页（选工作区那屏） ── */
patch('src/components/WelcomeView.vue', (s) => {
  const lines = s.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes('<div class="logo">'))
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '      </div>') {
      end = i
      break
    }
  }
  if (start < 0 || end < 0) throw new Error('logo 块没找到')

  const block = [
    '      <!-- 首屏这枚标用**应用图标本身**（奶油底手写体那张）。',
    '           它够大（52px）不会糊，而这里是人第一次看到这个应用的地方，',
    '           应当让他一眼认出「这就是我在桌面点开的那个东西」。',
    '           侧栏顶栏仍留描边版 —— 那儿只有 18px，位图会糊成一格色块。 -->',
    '      <img class="logo" :src="appIcon" width="52" height="52" alt="Nota" />',
  ]
  lines.splice(start, end - start + 1, ...block)

  // import
  const imp = "import { store } from '@/store'"
  const at = lines.findIndex((l) => l === imp)
  if (at < 0) throw new Error('import 锚点没找到')
  lines.splice(at + 1, 0, "import appIcon from '@/assets/app-icon.png'")

  // 样式：图标自带奶油底与圆角，不再需要强调色底衬托
  const st = lines.findIndex((l) => l === '.logo {')
  if (st < 0) throw new Error('.logo 样式没找到')
  let se = st
  while (lines[se] !== '}') se++
  lines.splice(st, se - st + 1, ...[
    '.logo {',
    '  display: block;',
    '  width: 52px;',
    '  height: 52px;',
    '  margin: 0 auto 16px;',
    '  border-radius: var(--n-r-lg);',
    '}',
  ])

  return lines.join('\n')
})

/* ── 2. 设置 · 关于页 ── */
patch('src/components/SettingsDialog.vue', (s) => {
  const lines = s.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes('<span class="ab-mark"'))
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].includes('</svg>')) {
      end = i
      break
    }
  }
  if (start < 0 || end < 0) throw new Error('ab-mark 块没找到')

  const block = [
    '                <span class="ab-mark" aria-hidden="true">',
    '                  <!-- 关于页这枚标用应用图标本身：它是「这个应用长什么样」',
    '                       的直接回答，52px 也足够撑住位图细节。 -->',
    '                  <img :src="appIcon" width="48" height="48" alt="Nota" />',
    '                </span>',
  ]
  lines.splice(start, end - start + 1, ...block)

  const imp = "import { store } from '@/store'"
  const at = lines.findIndex((l) => l === imp)
  if (at < 0) throw new Error('import 锚点没找到')
  lines.splice(at + 1, 0, "import appIcon from '@/assets/app-icon.png'")

  const st = lines.findIndex((l) => l === '.ab-mark {')
  if (st < 0) throw new Error('.ab-mark 样式没找到')
  let se = st
  while (lines[se] !== '}') se++
  lines.splice(st, se - st + 1, ...[
    '.ab-mark {',
    '  position: relative;',
    '  flex: none;',
    '  display: inline-flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  width: 52px;',
    '  height: 52px;',
    '  border-radius: var(--n-r-lg);',
    // 图标自带奶油底和圆角，再垫一层强调色底反而把它压脏
    '  overflow: hidden;',
    '}',
    '',
    '.ab-mark img {',
    '  width: 48px;',
    '  height: 48px;',
    '  border-radius: calc(var(--n-r-lg) - 2px);',
    '}',
  ])

  return lines.join('\n')
})
