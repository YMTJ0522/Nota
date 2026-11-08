/**
 * 验证单实例锁的「安装交接重试」：
 * 装完点「打开 Nota」的瞬间，安装器进程还攥着锁，新进程可能抢锁失败。
 * 安装器会留下 install-handoff 标记，抢锁失败的新进程看到新鲜标记就
 * 等锁释放后重试，而不是直接退出。
 *
 *   B1 正例：实例 A 持锁 → 写新鲜 handoff → 启动 B（抢锁失败进重试）
 *      → 杀掉 A → B 应在数秒内拿到锁并启动出主窗口
 *   B2 反例：同样的持锁场景但**没有** handoff → B 应立即退出（老行为）
 *
 *   node scripts/verify-handoff-retry.mjs <Nota.exe 路径>
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const exe = process.argv[2]
if (!exe) {
  console.error('用法: node verify-handoff-retry.mjs <Nota.exe>')
  process.exit(2)
}

delete process.env.ELECTRON_RUN_AS_NODE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const ok = (m) => console.log('  ✓ ' + m)
const fail = (m) => { console.error('  ✗ ' + m); failed = true }

function cdpPageTargets(port) {
  return fetch(`http://127.0.0.1:${port}/json`)
    .then((r) => r.json())
    .then((l) => l.filter((t) => t.type === 'page'))
    .catch(() => [])
}

/** 启动一个实例。返回 { child, home, port }
 *  注意 ELECTRON_RUN_AS_NODE 必须 delete：设成空字符串也会让 Electron 变 Node。 */
function launch(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-handoff-'))
  const env = { ...process.env, NOTA_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(exe),
    env,
    stdio: 'ignore',
  })
  return { child, home, port }
}

/* ── B1：有 handoff，等 A 退出后 B 接管 ── */
console.log('B1 有交接标记：')
const A = launch(9226)
/* 等 A 起来并持锁（主窗口 page 出现即视为 ready） */
let aUp = false
for (let i = 0; i < 40 && !aUp; i++) {
  await sleep(500)
  aUp = (await cdpPageTargets(9226)).length > 0
}
if (!aUp) { fail('A 实例 20 秒内没起来'); process.exit(1) }
ok('A 实例已启动并持锁')

/* 新鲜 handoff：mtime 必须是刚刚。真实流程里安装器在点「打开 Nota」时写。 */
const sentinel = path.join(A.home, 'install-handoff')
fs.writeFileSync(sentinel, `${new Date().toISOString()} C:\\fake\\Nota.exe\n`)

const B = launch(9227)
await sleep(1500) /* B 此刻应已抢锁失败、进入 200ms 重试循环 */

A.child.kill()
await sleep(500)

/* B 应在重试中拿到锁并 boot 出主窗口 */
let bUp = false
for (let i = 0; i < 30 && !bUp; i++) {
  await sleep(500)
  bUp = (await cdpPageTargets(9227)).length > 0
}
if (bUp) ok('A 退出后 B 拿到锁并启动出主窗口')
else fail('A 退出后 B 没能接管 —— 交接重试没生效')

B.child.kill()
A.child.kill().catch?.(() => {})
try { fs.rmSync(A.home, { recursive: true, force: true }) } catch {}
try { fs.rmSync(B.home, { recursive: true, force: true }) } catch {}
await sleep(800)

/* ── B2：没有 handoff，B 直接退出。
   锁按 userData 划分 —— D 必须和 C 共用同一个数据目录才构成争锁。 */
console.log('B2 无交接标记（控制组）：')
const C = launch(9228)
let cUp = false
for (let i = 0; i < 40 && !cUp; i++) {
  await sleep(500)
  cUp = (await cdpPageTargets(9228)).length > 0
}
if (!cUp) { fail('C 实例 20 秒内没起来'); process.exit(1) }

const D = spawn(exe, ['--remote-debugging-port=9229'], {
  cwd: path.dirname(exe),
  env: { ...process.env, NOTA_HOME: C.home },
  stdio: 'ignore',
})
const exited = await Promise.race([
  new Promise((r) => D.once('exit', () => r(true))),
  sleep(3000).then(() => false),
])
if (exited) ok('D 实例抢锁失败后立即退出（无标记不重试）')
else fail('D 实例 3 秒还没退 —— 没标记也不该等')

D.kill()
C.child.kill()
try { fs.rmSync(C.home, { recursive: true, force: true }) } catch {}
try { fs.rmSync(D.home, { recursive: true, force: true }) } catch {}

console.log(failed ? '\n❌ 有断言失败' : '\n✅ 全部通过')
process.exit(failed ? 1 : 0)
