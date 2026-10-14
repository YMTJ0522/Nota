import { outlineFromSource } from './_probe-pr.mjs'
import fs from 'fs'
for (const f of ['demo/进阶/05 代码块与表格.md','demo/进阶/06 图表与流程图.md','demo/进阶/07 数学公式.md','demo/Nota 功能测试.md']) {
  const md = fs.readFileSync(f, 'utf8').replace(/^﻿/, '')
  const items = outlineFromSource(md)
  console.log(`\n${f}  (${md.split('\n').length} 行, ${items.length} 个标题)`)
  items.forEach(i => console.log(`   H${i.level} ${JSON.stringify(i.text)} @${i.line+1}`))
}
