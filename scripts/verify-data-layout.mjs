/**
 * 数据布局：一个库装完全部。
 *
 * 验三件事，都是「用户真正会遇到的那几种情况」：
 *
 *  1. 老用户升级上来：设置留在机器级目录、便签也在机器级目录，第一次带着库
 *     启动时要整份搬进库，否则用户看到的是「我的设置没了、便签全不见」。
 *  2. 搬完旧位置要留着：装回旧版本时那边仍然是完整一份，不然降级就是空白。
 *  3. 设置是碎片写（拖一下分隔线就写一次），并发写不能互相覆盖。
 *
 * 不需要启动 Electron：这些全是纯文件操作。
 *
 * 用法：node --experimental-strip-types scripts/verify-data-layout.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateStickies, patchSettings, readSettings } from '../electron/settings.ts'

let pass = 0
const fail = []
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail.push(name)
    console.log(`  FAIL  ${name}  ${detail ?? ''}`)
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-layout-'))
const MACHINE = path.join(TMP, 'local') // 相当于 %LOCALAPPDATA%\Nota 的上一层
const VAULT = path.join(TMP, 'vault')
const MACHINE_NOTA = path.join(MACHINE, 'Nota')

fs.mkdirSync(MACHINE_NOTA, { recursive: true })
fs.mkdirSync(VAULT, { recursive: true })

/* ── 造一个「老用户」：设置与便签都在机器级 ── */
fs.writeFileSync(
  path.join(MACHINE_NOTA, 'settings.json'),
  JSON.stringify({ 'nota-theme': 'dark', 'nota-accent': 'indigo', 'nota-ai': { model: 'x' } }),
  'utf8',
)
const oldStickies = path.join(MACHINE_NOTA, 'stickies')
fs.mkdirSync(oldStickies, { recursive: true })
fs.writeFileSync(path.join(oldStickies, 'index.json'), '[]', 'utf8')
fs.writeFileSync(path.join(oldStickies, 's-1.md'), '第一张', 'utf8')

console.log('\n── 老用户第一次带库启动 ──')

/* 1. 设置搬家 */
const r1 = await readSettings(VAULT, MACHINE)
ok('机器级设置被搬进库', r1.data['nota-theme'] === 'dark', JSON.stringify(r1.data))
ok('搬家有记录（哪来的）', r1.migratedFrom === path.join(MACHINE_NOTA, 'settings.json'))
ok('落在 .nota/settings.json', r1.path === path.join(VAULT, '.nota', 'settings.json'))
ok('库里确实有了这个文件', fs.existsSync(r1.path))
ok('旧位置没被删（降级要靠它）', fs.existsSync(path.join(MACHINE_NOTA, 'settings.json')))

/* 2. 便签搬家 */
const m1 = await migrateStickies(VAULT, MACHINE)
/* index.json 不跟着搬：它是「记录」，跟另一份混起来会互相覆盖；
   正文和图搬过去之后，listStickies 会按磁盘文件把记录补出来 */
ok('便签搬进库', m1 && m1.copied === 1, JSON.stringify(m1))
ok('库内有便签目录', fs.existsSync(path.join(VAULT, '.nota', 'stickies', 's-1.md')))
ok('旧便签没被删', fs.existsSync(path.join(oldStickies, 's-1.md')))

/* 3. 再启动一次不重复搬 */
const m2 = await migrateStickies(VAULT, MACHINE)
ok('重复启动不会叠加', m2 === null, JSON.stringify(m2))

console.log('\n── 设置读写 ──')

/* 4. 合并写：只覆盖传进来的键 */
await patchSettings(VAULT, MACHINE, { 'nota-accent': 'amber' })
const r2 = await readSettings(VAULT, MACHINE)
ok('改一个键不影响别的', r2.data['nota-theme'] === 'dark' && r2.data['nota-accent'] === 'amber')

/* 5. null 表示删键 */
await patchSettings(VAULT, MACHINE, { 'nota-ai': null })
const r3 = await readSettings(VAULT, MACHINE)
ok('传 null 就把键删掉', r3.data['nota-ai'] === undefined)

/* 6. 并发写不互相覆盖 —— 这是那个队列存在的理由 */
await Promise.all(
  Array.from({ length: 20 }, (_, i) => patchSettings(VAULT, MACHINE, { [`k${i}`]: i })),
)
const r4 = await readSettings(VAULT, MACHINE)
const got = Array.from({ length: 20 }, (_, i) => r4.data[`k${i}`]).filter((v) => v !== undefined)
ok('并发 20 笔一笔都没丢', got.length === 20, `只有 ${got.length} 笔`)

/* 7. 坏文件不该让程序起不来 */
fs.writeFileSync(path.join(VAULT, '.nota', 'settings.json'), '{坏掉的', 'utf8')
const r5 = await readSettings(VAULT, null)
ok('设置文件坏了就当空，不抛', r5 && typeof r5.data === 'object', JSON.stringify(r5?.data))

/* 8. 没有库时走机器级 */
const r6 = await readSettings(null, MACHINE)
ok('没有库时读机器级那份', r6.path === path.join(MACHINE_NOTA, 'settings.json'))

/* 9. 库里已经有便签时，只补它没有的那几张，不重复搬 */
const other = path.join(TMP, 'vault2')
fs.mkdirSync(path.join(other, '.nota', 'stickies'), { recursive: true })
fs.writeFileSync(path.join(other, '.nota', 'stickies', 's-9.md'), '本库自己的', 'utf8')
const m3 = await migrateStickies(other, MACHINE)
ok('库里已有的那张不重复搬', fs.readdirSync(path.join(other, '.nota', 'stickies')).filter((n) => n === 's-9.md').length === 1)
ok('库里没有的那几张照旧补进来', fs.existsSync(path.join(other, '.nota', 'stickies', 's-1.md')), JSON.stringify(m3))
const m4 = await migrateStickies(other, MACHINE)
ok('搬过之后留了记号，下次不再看机器级', m4 === null, JSON.stringify(m4))

/* 10. 用户在库里删掉一张，下次启动不该被机器级那份复活 */
fs.rmSync(path.join(other, '.nota', 'stickies', 's-1.md'))
const m5 = await migrateStickies(other, MACHINE)
ok('删掉的便签不会被旧目录复活', m5 === null && !fs.existsSync(path.join(other, '.nota', 'stickies', 's-1.md')))

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n${pass} 通过，${fail.length} 失败`)
if (fail.length) {
  console.log('失败项：\n' + fail.map((f) => '  · ' + f).join('\n'))
  process.exit(1)
}
console.log('ALL PASS')
