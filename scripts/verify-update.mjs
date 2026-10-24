// 验证版本比较（electron/version.ts）。
//
// 这段代码写错了界面不会有任何异常 —— 只会「明明有新版，它说已是最新」，
// 或者反过来「每次点都提示更新」。所以边界必须一条条钉住。
//
//   node scripts/verify-update.mjs
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  '..',
)
const OUT = path.join(ROOT, '.tmp-update-test.mjs')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  \x1b[32m✓\x1b[0m ' + name)
  } else {
    fail++
    console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : ''))
  }
}

await build({
  entryPoints: [path.join(ROOT, 'electron', 'version.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: OUT,
  logLevel: 'silent',
})

const { compareVersion } = await import(pathToFileURL(OUT).href)

console.log('\n新版在这边（应当 >）')
ok('2.7.9 > 2.7.8', compareVersion('2.7.9', '2.7.8') === 1)
// 这一条是整段代码存在的理由：字符串比较会认为 '2.7.10' < '2.7.9'
ok('2.7.10 > 2.7.9（字符串比会反过来）', compareVersion('2.7.10', '2.7.9') === 1, JSON.stringify(['2.7.10' < '2.7.9']))
ok('2.8.0 > 2.7.99', compareVersion('2.8.0', '2.7.99') === 1)
ok('3.0.0 > 2.99.99', compareVersion('3.0.0', '2.99.99') === 1)
ok('10.0.0 > 9.9.9', compareVersion('10.0.0', '9.9.9') === 1)

console.log('\n同一版（应当 =）')
ok('2.7.8 = 2.7.8', compareVersion('2.7.8', '2.7.8') === 0)
ok('带 v 前缀也算同一版', compareVersion('v2.7.8', '2.7.8') === 0)
ok('前后空格不影响', compareVersion('  2.7.8  ', '2.7.8') === 0)
ok('2.7 = 2.7.0（缺的段按 0 补）', compareVersion('2.7', '2.7.0') === 0)

console.log('\n旧版在这边（应当 <）')
ok('2.7.8 < 2.7.9', compareVersion('2.7.8', '2.7.9') === -1)
ok('2.7.9 < 2.7.10', compareVersion('2.7.9', '2.7.10') === -1)
ok('2.7.8 < 2.8.0', compareVersion('2.7.8', '2.8.0') === -1)

console.log('\n脏输入不能崩')
ok('空串当 0.0.0', compareVersion('', '1.0.0') === -1, String(compareVersion('', '1.0.0')))
ok('非数字段按 0', compareVersion('abc', '0.0.0') === 0, String(compareVersion('abc', '0.0.0')))
ok('对空串就是更新', compareVersion('2.7.8', '') === 1)
ok('undefined 不抛', (() => {
  try {
    compareVersion(undefined, '1.0.0')
    return true
  } catch {
    return false
  }
})())

console.log('\n真实判断：只有官网更“新”才提示')
const isNewer = (latest, current) => compareVersion(latest, current) > 0
ok('官网 2.7.9，本地 2.7.8 → 提示', isNewer('2.7.9', '2.7.8') === true)
ok('官网 2.7.8，本地 2.7.8 → 不提示', isNewer('2.7.8', '2.7.8') === false)
// 本地比官网新（装了内测版，或官网还没改）：不能反过来让人「更新」到更旧的版本
ok('官网 2.7.7，本地 2.7.8 → 不提示', isNewer('2.7.7', '2.7.8') === false)
ok('官网 2.7.10，本地 2.7.9 → 提示', isNewer('2.7.10', '2.7.9') === true)

fs.rmSync(OUT, { force: true })

console.log(`\n${fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m有失败\x1b[0m'}  ${pass} 项通过，${fail} 项失败\n`)
process.exit(fail === 0 ? 0 : 1)
