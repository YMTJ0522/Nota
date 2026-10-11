/**
 * 一次性诊断：看 app.asar 里的体积都被谁占了。
 * asar 的头部是一段 pickle JSON，直接从字节流里把 JSON 捞出来即可。
 */
import fs from 'node:fs'

const f = 'release/win-unpacked/resources/app.asar'
const buf = fs.readFileSync(f)
const start = buf.indexOf('{"files"')
if (start < 0) throw new Error('找不到 asar 头部')

// 按花括号配平取出完整 JSON
let depth = 0
let end = -1
for (let i = start; i < buf.length; i++) {
  if (buf[i] === 0x7b) depth++
  else if (buf[i] === 0x7d) {
    depth--
    if (depth === 0) { end = i + 1; break }
  }
}
const tree = JSON.parse(buf.slice(start, end).toString('utf-8'))

const list = []
;(function flat(node, path) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = path ? `${path}/${name}` : name
    if (child.files) flat(child, p)
    else list.push([p, child.size || 0])
  }
})(tree, '')

const total = list.reduce((a, b) => a + b[1], 0)
console.log(`asar 文件数 ${list.length}，内容合计 ${(total / 1048576).toFixed(1)} MB\n`)

const byPkg = {}
for (const [p, s] of list) {
  const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(p)
  const k = m ? m[1] : p.split('/')[0] || '(root)'
  byPkg[k] = (byPkg[k] || 0) + s
}
console.log('── 按包 ──')
for (const [k, v] of Object.entries(byPkg).sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`${(v / 1048576).toFixed(1).padStart(8)} MB  ${k}`)
}

const ext = {}
for (const [p, s] of list) {
  const e = (/\.[^./\\]+$/.exec(p) || ['(无扩展名)'])[0].toLowerCase()
  ext[e] = (ext[e] || 0) + s
}
console.log('\n── 按扩展名 ──')
for (const [k, v] of Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`${(v / 1048576).toFixed(1).padStart(8)} MB  ${k}`)
}

console.log('\n── 前 15 大文件 ──')
for (const [p, s] of list.sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`${(s / 1048576).toFixed(1).padStart(8)} MB  ${p}`)
}
