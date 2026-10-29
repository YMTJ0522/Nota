/**
 * 双链解析：`[[名字]]` 落到哪一篇、正文里都有哪些链接。
 *
 * 只验规则，不开窗口也不碰磁盘 —— 规则有三个调用方（预览、链接栏、
 * 关系图），任何一处走偏都是「点得动但连不上」这类难查的毛病。把判断
 * 放在一个纯函数里，就是为了能这样一行行钉住。
 *
 * 用法：node --experimental-strip-types scripts/verify-links.mjs
 */
import { resolveWikiNote, outgoingLinks } from '../src/editor/wiki-resolve.ts'

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

/* 一份小工作区。路径用 Windows 的反斜杠，跟真机上拿到的一致 */
const ROOT = 'C:\\Users\\me\\Nota'
const FILES = [
  { path: 'C:\\Users\\me\\Nota\\日记\\2026-10-01.md', name: '2026-10-01.md' },
  { path: 'C:\\Users\\me\\Nota\\日记\\2026-10-02.md', name: '2026-10-02.md' },
  { path: 'C:\\Users\\me\\Nota\\读书笔记.md', name: '读书笔记.md' },
  { path: 'C:\\Users\\me\\Nota\\项目\\读书笔记.md', name: '读书笔记.md' },
  { path: 'C:\\Users\\me\\Nota\\唯一.md', name: '唯一.md' },
  { path: 'C:\\Users\\me\\Nota\\项目\\计划.md', name: '计划.md' },
  { path: 'C:\\Users\\me\\Nota\\归档\\计划.md', name: '计划.md' },
]

console.log('\n── 名字落到哪一篇 ──')

ok(
  '路径形式必中（重名也架不住路径）',
  resolveWikiNote('日记/2026-10-01', FILES, ROOT) === 'C:\\Users\\me\\Nota\\日记\\2026-10-01.md',
  resolveWikiNote('日记/2026-10-01', FILES, ROOT),
)

ok(
  '全库唯一的名字能命中',
  resolveWikiNote('唯一', FILES, ROOT) === 'C:\\Users\\me\\Nota\\唯一.md',
  resolveWikiNote('唯一', FILES, ROOT),
)

ok(
  '重名但有一篇在库根 → 认库根那篇（路径形式，结果确定）',
  resolveWikiNote('读书笔记', FILES, ROOT) === 'C:\\Users\\me\\Nota\\读书笔记.md',
  resolveWikiNote('读书笔记', FILES, ROOT),
)

ok(
  '重名且都在子目录、又没写路径 → 不猜，返回空',
  resolveWikiNote('计划', FILES, ROOT) === null,
  resolveWikiNote('计划', FILES, ROOT),
)

ok(
  '重名但带对路径 → 命中那一篇',
  resolveWikiNote('项目/读书笔记', FILES, ROOT) === 'C:\\Users\\me\\Nota\\项目\\读书笔记.md',
  resolveWikiNote('项目/读书笔记', FILES, ROOT),
)

ok(
  '名字带 .md 后缀也认',
  resolveWikiNote('唯一.md', FILES, ROOT) === 'C:\\Users\\me\\Nota\\唯一.md',
  resolveWikiNote('唯一.md', FILES, ROOT),
)

/* 库根换成斜杠写法：真机上 root 可能来自另一个 IPC，两种分隔符都见过 */
ok(
  '库根用正斜杠也命中（分隔符要归一化，不是删掉）',
  resolveWikiNote('日记/2026-10-02', FILES, 'C:/Users/me/Nota') ===
    'C:\\Users\\me\\Nota\\日记\\2026-10-02.md',
  resolveWikiNote('日记/2026-10-02', FILES, 'C:/Users/me/Nota'),
)

ok(
  '库根为空时只按名字猜（还认得出唯一那篇）',
  resolveWikiNote('唯一', FILES, null) === 'C:\\Users\\me\\Nota\\唯一.md',
  resolveWikiNote('唯一', FILES, null),
)

ok(
  '名字写错目录、但末段全库唯一 → 仍命中',
  resolveWikiNote('别的目录/唯一', FILES, ROOT) === 'C:\\Users\\me\\Nota\\唯一.md',
  resolveWikiNote('别的目录/唯一', FILES, ROOT),
)

ok(
  '哪篇都不像 → 空',
  resolveWikiNote('根本没这篇', FILES, ROOT) === null,
  resolveWikiNote('根本没这篇', FILES, ROOT),
)

console.log('\n── 正文里的链接 ──')

const one = (text) => outgoingLinks(text)

ok('普通双链', one('见 [[唯一]]。').length === 1 && one('见 [[唯一]]。')[0].target === '唯一')
ok(
  '带别名：target 去别名，alias 留着',
  one('[[唯一|那个]]')[0].target === '唯一' && one('[[唯一|那个]]')[0].alias === '那个',
  JSON.stringify(one('[[唯一|那个]]')),
)
ok('嵌入算链接，且标出来', one('![[唯一]]')[0].embed === true)
ok('块引用只取篇名', one('[[唯一#^abc123]]')[0].target === '唯一', one('[[唯一#^abc123]]')[0].target)
ok('标题锚点只取篇名', one('[[唯一#小节]]')[0].target === '唯一')
ok('本篇内部锚点不列出', one('[[#^abc]]').length === 0)
ok('markdown 链接指向 .md', one('[看这里](日记/2026-10-01.md)')[0].target === '日记/2026-10-01')
ok('外链不算', one('[谷歌](https://www.google.com)').length === 0)
ok('外链就算以 .md 结尾也不算', one('[x](https://a.com/b.md)').length === 0)
ok('非 md 的本地链接不算', one('[图](assets/a.png)').length === 0)

const fenced = '```\n[[不是链接]]\n```\n'
ok('围栏代码块里的不列', one(fenced).length === 0, JSON.stringify(one(fenced)))
const inline = '用 `[[示例]]` 这种写法\n'
ok('行内代码里的不列', one(inline).length === 0, JSON.stringify(one(inline)))
const math = '$$\n[[公式里的]]\n$$\n'
ok('公式块里的不列', one(math).length === 0, JSON.stringify(one(math)))

ok(
  '同一篇提两次只列一行',
  one('[[唯一]] 又 [[唯一]]').length === 1,
  JSON.stringify(one('[[唯一]] 又 [[唯一]]')),
)
ok(
  '别名不同算两条（写法不同就是要分别看）',
  one('[[唯一]] 与 [[唯一|别名]]').length === 2,
  JSON.stringify(one('[[唯一]] 与 [[唯一|别名]]')),
)
ok('顺序按出现先后', one('[[乙]] 然后 [[甲]]').map((x) => x.target).join(',') === '乙,甲')

/* 一段真会出现的正文：代码块里的示例不能被当成「链到了谁」 */
const real = `# 周记

这周读了 [[读书笔记]]，顺手记在 [[日记/2026-10-01|周一的日记]] 里。

\`\`\`md
链接写法：[[目标笔记]]
\`\`\`

下周再补 [上周那篇](日记/2026-10-02.md)。
`
const got = one(real).map((x) => x.target)
ok('混排正文里只挑出真的三条', got.join(',') === '读书笔记,日记/2026-10-01,日记/2026-10-02', got.join(','))

console.log(`\n${pass} 通过，${fail.length} 失败`)
if (fail.length) {
  console.log('失败项：')
  for (const f of fail) console.log('  ·', f)
  process.exit(1)
}
