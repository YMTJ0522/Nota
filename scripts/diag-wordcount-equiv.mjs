/** 对比「旧写法」与「单趟写法」的字数结果，必须逐个文件分毫不差 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/* ── 旧写法（五遍正则 + 大量分配） ── */
function oldCount(text) {
  if (!text) return { chars: 0, words: 0, lines: 0 }
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const chars = body.replace(/\s/g, '').length
  const chineseChars = (body.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const englishText = body.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ')
  const englishWords = englishText
    .split(/\s+/)
    .filter((w) => w.length > 0 && /[a-zA-Z0-9]/.test(w)).length
  const words = chineseChars + englishWords
  const lines = body.split('\n').length
  return { chars, words, lines }
}

/* ── 新写法：一趟扫描，不分配中间字符串 ── */
function isSpace(cp) {
  return (
    cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d ||
    cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 ||
    cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff
  )
}
const isCJK = (cp) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
const isAsciiAlnum = (cp) =>
  (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)

function fmEnd(text) {
  if (
    text.charCodeAt(0) === 45 && text.charCodeAt(1) === 45 &&
    text.charCodeAt(2) === 45 && text.charCodeAt(3) === 10
  ) {
    /* 注意起点是 4 不是 3：`^---\n` 吃掉了四个字符，
       惰性段从下标 4 开始找 `\n---`。早一位会在「---\n---」上误判成有 frontmatter。 */
    const close = text.indexOf('\n---', 4)
    if (close >= 0) {
      let end = close + 4
      if (text.charCodeAt(end) === 10) end++
      return end
    }
  }
  return 0
}

function newCount(text) {
  if (!text) return { chars: 0, words: 0, lines: 0 }
  const start = fmEnd(text)
  let chars = 0, chinese = 0, english = 0, lines = 1, hasAlnum = false
  for (let i = start; i < text.length; i++) {
    const cp = text.charCodeAt(i)
    const cjk = isCJK(cp)
    if (!isSpace(cp)) chars++
    if (cjk) chinese++
    if (cjk || isSpace(cp)) {
      if (hasAlnum) english++
      hasAlnum = false
    } else if (isAsciiAlnum(cp)) {
      hasAlnum = true
    }
    if (cp === 0x0a) lines++
  }
  if (hasAlnum) english++
  return { chars, words: chinese + english, lines }
}

/* ── 样本：demo 全部笔记 + 一批边界 ── */
const ROOT = 'demo'
function walk(d) {
  const out = []
  for (const n of readdirSync(d)) {
    const p = path.join(d, n)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.md')) out.push(p)
  }
  return out
}
const files = walk(ROOT)

const cases = [
  ['', '空串'],
  ['\n', '只有一个换行'],
  ['---\ntitle: x\n---\n正文 Chinese 与 english 123\n', '带 frontmatter'],
  ['---\n---\nabc', 'frontmatter 紧贴'],
  ['---\n未闭合\n还是正文 变量a 另一个b\n', 'frontmatter 未闭合'],
  ['中文中文english words:2 U+3000　结束\n\n多行\n\n', '含全角空格'],
  ['---a\nb\n---\nc  d\n', '开头不是纯 ---'],
  ['a,b.c;d-e_f\n', '标点连着的词'],
  ['﻿abc 中文\n', 'BOM'],
  ['…—–—\u2028\u2029 x\n', '各种空白'],
  ['甲乙丙\n丁戊己\n', '纯中文'],
  ['123 456\n', '纯数字'],
]

let bad = 0
for (const [text, name] of cases) {
  const a = oldCount(text)
  const b = newCount(text)
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++
    console.log(`❌ ${name}: old=${JSON.stringify(a)} new=${JSON.stringify(b)}`)
  }
}
for (const f of files) {
  const a = oldCount(readFileSync(f, 'utf8'))
  const b = newCount(readFileSync(f, 'utf8'))
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++
    console.log(`❌ ${f}: old=${JSON.stringify(a)} new=${JSON.stringify(b)}`)
  }
}
console.log(bad === 0 ? `✅ 新旧一致（${files.length} 篇笔记 + ${cases.length} 个边界用例）` : `❌ ${bad} 处不一致`)

/* 顺便量一下快慢 */
const big = readFileSync(files[0], 'utf8').repeat(40)
const bench = (fn, n = 40) => {
  const t = process.hrtime.bigint()
  for (let i = 0; i < n; i++) fn(big)
  return Number(process.hrtime.bigint() - t) / 1e6 / n
}
console.log(`\n样本 ${(big.length / 1024).toFixed(0)} KB`)
console.log(`  旧 ${bench(oldCount).toFixed(2)} ms/次`)
console.log(`  新 ${bench(newCount).toFixed(2)} ms/次`)
