/**
 * 大纲提取探针。
 *
 * 用户报「代码块里的注释出现在大纲尾部」。outlineFromSource 里已经有围栏
 * 状态机，所以要先把**各种代码块形态**都摆出来，看是哪一类漏的，不能猜。
 */
import { outlineFromSource } from './_probe-pr.mjs'

const cases = {
  'A. 普通围栏 + 井号注释': [
    '# 真标题一',
    '',
    '```python',
    '# 这是代码里的注释',
    'x = 1',
    '```',
    '',
    '## 真标题二',
  ].join('\n'),

  'B. 围栏 + 双斜杠注释': [
    '# 标题',
    '',
    '```js',
    '// TODO 这里要改',
    'const a = 1',
    '```',
  ].join('\n'),

  'C. 四反引号包三反引号': [
    '# 标题',
    '',
    '````markdown',
    '```python',
    '# 内层注释',
    '```',
    '````',
  ].join('\n'),

  'D. 波浪号围栏': [
    '# 标题',
    '',
    '~~~bash',
    '# 注释',
    'ls -la',
    '~~~',
  ].join('\n'),

  'E. 缩进式代码块（4 空格）': [
    '# 标题',
    '',
    '    # 缩进代码里的注释',
    '    echo hi',
  ].join('\n'),

  'F. 引用块里的围栏': [
    '# 标题',
    '',
    '> ```sh',
    '> # 注释',
    '> echo hi',
    '> ```',
  ].join('\n'),

  'G. 围栏未闭合（写到一半）': ['# 标题', '', '```python', '# 还没写关栏'].join('\n'),

  'H. 围栏后紧跟井号（无空行）': ['# 标题', '```sh', 'echo 1', '```', '# 后面这个也是注释?'].join('\n'),

  'I. 带语言与属性的高级块': [
    '# 标题',
    '',
    '```js title="保存流程" line-numbers {2}',
    'const dirty = doc !== saved',
    'if (!dirty) return   // 这一行会被标出来',
    '```',
  ].join('\n'),

  'J. 制表符缩进的围栏': ['# 标题', '', '\t```sh', '\t# 注释', '\techo', '\t```'].join('\n'),
}

for (const [name, md] of Object.entries(cases)) {
  const items = outlineFromSource(md)
  const lines = items.map((i) => `    H${i.level} ${i.text}  (源码第 ${i.line + 1} 行)`)
  console.log(`\n${name}`)
  console.log(lines.length ? lines.join('\n') : '    （空）')
}
