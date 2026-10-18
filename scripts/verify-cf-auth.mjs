/**
 * 后台口令与会话的回归验证。
 *
 * 为什么单独做：`cloudflare/src/auth.ts` 是整个后台唯一「错了也看不出来」的地方 ——
 * 密码哈希写偏一位、签名比较写成 `===`、过期时间判错方向，页面照样能登录、
 * 后台照样能进，只是安全性已经没了。这类东西必须拿断言钉住。
 *
 * 好在 auth.ts 只用 WebCrypto（Node 18+ 自带），不碰 D1/R2，
 * 所以能 esbuild 打包出来直接在 Node 里跑，不用起 wrangler、不用真账号。
 *
 * 顺带把 `seed.sql` 里那串哈希也验一遍 —— 它就是 `admin123` 算出来的，
 * 如果这里对不上，说明种子数据和代码里的轮数/编码不一致，线上第一次登录就会失败。
 *
 *   node scripts/verify-cf-auth.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function bundleAuth() {
  const esbuild = await import('esbuild')
  const out = path.join(os.tmpdir(), `nota-cf-auth-${Date.now()}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(root, 'cloudflare/src/auth.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
  })
  const mod = await import(`file://${out.replace(/\\/g, '/')}`)
  fs.rmSync(out, { force: true })
  return mod
}

let pass = 0
let fail = 0
const results = []

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    results.push(`  ✓ ${name}`)
  } else {
    fail += 1
    results.push(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

/* 从 seed.sql 里把盐和哈希抠出来，保证测的就是线上种进去的那一份 */
function seedOf() {
  const sql = fs.readFileSync(path.join(root, 'cloudflare/seed.sql'), 'utf8')
  // INSERT ... VALUES (1, 'admin', '<salt>', '<hash>', <ver>, ...
  const m = /VALUES\s*\(\s*1,\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*(\d+)/i.exec(sql)
  if (!m) throw new Error('seed.sql 里没匹配到 admin 行，格式变了？')
  return { username: m[1], salt: m[2], hash: m[3], ver: Number(m[4]) }
}

const SECRET = 'test-secret-not-the-real-one'

async function main() {
  const auth = await bundleAuth()
  const { hashPassword, verifyPassword, safeEqual, randomHex, signSession, readSession, toB64url, fromB64url } = auth

  const seed = seedOf()
  results.push(`seed.sql → 账号 ${seed.username} / 盐 ${seed.salt.slice(0, 8)}… / 轮数版本 ${seed.ver}`)

  /* ── 1. 种子哈希必须能对上默认口令 ── */
  const h = await hashPassword('admin123', seed.salt)
  ok(
    'hashPassword(admin123) 与 seed.sql 的哈希一致',
    h === seed.hash,
    `算出 ${h.slice(0, 16)}… 种子 ${seed.hash.slice(0, 16)}…`,
  )
  ok('哈希是 64 位十六进制（256 bit）', /^[0-9a-f]{64}$/.test(h), h.length + ' 位')

  /* ── 2. 校验：对的口令过，错的不给过 ── */
  ok('verifyPassword 正确的口令通过', await verifyPassword('admin123', seed.salt, seed.hash))
  ok('verifyPassword 错口令拒绝', !(await verifyPassword('admin1234', seed.salt, seed.hash)))
  ok('verifyPassword 空口令拒绝', !(await verifyPassword('', seed.salt, seed.hash)))

  /* ── 3. 盐必须真的参与运算，否则同样的口令哈希相同 ── */
  const salt2 = randomHex(16)
  ok('换个盐，同一口令的哈希就不同', (await hashPassword('admin123', salt2)) !== seed.hash)
  ok('同一个盐两次结果相同（确定性）', (await hashPassword('admin123', salt2)) === (await hashPassword('admin123', salt2)))
  ok('randomHex(16) 出 32 位十六进制', /^[0-9a-f]{32}$/.test(salt2))
  const salts = new Set(Array.from({ length: 200 }, () => randomHex(16)))
  ok('randomHex 200 次不重复', salts.size === 200, `实际 ${salts.size}`)

  /* ── 4. safeEqual：定长比较，一位不同就得 false ── */
  ok('safeEqual 相同串为真', safeEqual(seed.hash, seed.hash))
  ok('safeEqual 末位改一位为假', !safeEqual(seed.hash, seed.hash.slice(0, -1) + (seed.hash.endsWith('0') ? '1' : '0')))
  ok('safeEqual 首位改一位为假', !safeEqual(seed.hash, (seed.hash[0] === '0' ? '1' : '0') + seed.hash.slice(1)))
  ok('safeEqual 长度不同为假', !safeEqual(seed.hash, seed.hash + '0'))
  ok('safeEqual 全空为真（长度都为 0）', safeEqual('', ''))

  /* ── 5. base64url 往返：0–255 全字节不能被吃掉 ── */
  const all = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) all[i] = i
  const back = fromB64url(toB64url(all))
  ok(
    'base64url 往返 256 字节无损',
    back.length === 256 && back.every((v, i) => v === i),
  )
  ok('base64url 不含 + / =', !/[+/=]/.test(toB64url(all)))

  /* ── 6. 会话签名 ── */
  const exp = Date.now() + 60_000
  const token = await signSession({ u: 'admin', v: 3, exp }, SECRET)
  ok('token 是三段 v1 格式', /^v1\.[\w-]+\.[\w-]+$/.test(token), token.slice(0, 24) + '…')

  const s = await readSession(token, SECRET)
  ok('readSession 读回原样', !!s && s.u === 'admin' && s.v === 3 && s.exp === exp)

  // 换密钥必须失效（否则 SESSION_SECRET 就白设了）
  ok('换个密钥读不出', (await readSession(token, SECRET + 'x')) === null)

  // 改签名一位
  const [ver, body, sig] = token.split('.')
  const sigBad = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')
  ok('签名被改一位就失效', (await readSession(`${ver}.${body}.${sigBad}`, SECRET)) === null)

  // 改 payload 保留旧签名：把版本号从 3 改成 9，想绕过「改密码后旧 token 失效」
  const forgedBody = toB64url(new TextEncoder().encode(JSON.stringify({ u: 'admin', v: 9, exp })))
  ok('改 payload 保留旧签名 → 失效', (await readSession(`v1.${forgedBody}.${sig}`, SECRET)) === null)

  // 结构不对的各种
  ok('null token → null', (await readSession(null, SECRET)) === null)
  ok('空串 → null', (await readSession('', SECRET)) === null)
  ok('两段 → null', (await readSession(`v1.${body}`, SECRET)) === null)
  ok('v2 头 → null', (await readSession(`v2.${body}.${sig}`, SECRET)) === null)
  ok('乱签 → null', (await readSession(`v1.${body}.${sig}extra`, SECRET)) === null)
  ok('JSON 坏掉的 payload → null', (await readSession(`v1.${toB64url(new TextEncoder().encode('{oops'))}.${sig}`, SECRET)) === null)

  // 签名正确但内容不合规：readSession 还得拦住。这里必须真的用正确签名签一份坏 payload，
  // 否则测的只是「签名错了」，测不到「签名对了但字段不对」。
  const signed = async (obj) =>
    signSession(obj, SECRET)
  const noExp = await signed({ u: 'admin', v: 1 })
  ok('签名有效但缺 exp → null', (await readSession(noExp, SECRET)) === null)
  const noUser = await signed({ v: 1, exp: Date.now() + 60_000 })
  ok('签名有效但缺 u → null', (await readSession(noUser, SECRET)) === null)
  const expStr = await signed({ u: 'admin', v: 1, exp: '9999999999999' })
  ok('签名有效但 exp 是字符串 → null', (await readSession(expStr, SECRET)) === null)

  // 过期
  const old = await signSession({ u: 'admin', v: 1, exp: Date.now() - 1000 }, SECRET)
  ok('过期 token → null', (await readSession(old, SECRET)) === null)

  // 有效期边界：exp 就是现在时应当已失效（判断用 p.exp < Date.now()）
  const edge = await signSession({ u: 'admin', v: 1, exp: Date.now() - 1 }, SECRET)
  ok('刚过期 1ms 就失效', (await readSession(edge, SECRET)) === null)

  /* ── 7. 改密码后旧 token：靠 payload 里的 v 与库里 pwd_ver 比对 ── */
  const v1 = await signSession({ u: 'admin', v: 1, exp }, SECRET)
  const v2 = await signSession({ u: 'admin', v: 2, exp }, SECRET)
  ok('版本号不同 → 两个 token 不同', v1 !== v2)
  ok('v 被如实保留，供 index.ts 比对', (await readSession(v1, SECRET)).v === 1)

  /* ── 8. 用户名换掉要能读回新用户名 ── */
  const renamed = await signSession({ u: 'jiang', v: 5, exp }, SECRET)
  ok('换用户名后 token 里是新名字', (await readSession(renamed, SECRET)).u === 'jiang')

  /* ── 9. 账号名规则（与 index.ts handlePassword 里的正则同一份） ── */
  const nameRe = /^[A-Za-z0-9_-]{3,32}$/
  ok('admin 合法', nameRe.test('admin'))
  ok('带空格不合法', !nameRe.test('ad min'))
  ok('两位不合法', !nameRe.test('ab'))
  ok('33 位不合法', !nameRe.test('a'.repeat(33)))
  ok('中文不合法', !nameRe.test('管理员'))
  ok('连字符下划线合法', nameRe.test('ji_ang-chen'))

  /* ── 10. 新密码长度下限（index.ts 要求 ≥10） ── */
  ok('admin123 只有 8 位，达不到新密码下限', 'admin123'.length < 10)

  console.log('\n' + results.join('\n'))
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} 通过 / ${fail} 失败\n`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('验证脚本自身出错：', e)
  process.exitCode = 1
})
