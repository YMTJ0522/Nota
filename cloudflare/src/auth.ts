/**
 * 口令与会话。
 *
 * 只用 WebCrypto，不引任何库：Workers 里没有 bcrypt 的原生实现，
 * 硬塞 wasm 会让这个项目变重；PBKDF2-SHA256 走 10 万轮对付「一个管理员账号」
 * 已经足够（攻击者拿到的是一份 32 字节的散列，跑字典也得按 10 万轮/次算）。
 *
 * 同一份代码在 Node 里也能跑（Node 18+ 自带 WebCrypto），所以口令校验
 * 可以脱离 Cloudflare 在本地测 —— 见 scripts/verify-cf-auth.mjs。
 */

const ITERATIONS = 100_000
const KEY_BITS = 256
const enc = new TextEncoder()

export interface SessionPayload {
  /** 用户名 */
  u: string
  /** 密码版本号，改密码后旧 token 立刻失效 */
  v: number
  /** 过期时间（毫秒） */
  exp: number
}

export function bytesToHex(b: Uint8Array): string {
  let out = ''
  for (const x of b) out += x.toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? '0' + hex : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** base64url（无填充）—— token 要放进 Cookie，`+/=` 都得换掉 */
export function toB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function randomHex(bytes = 16): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** PBKDF2-SHA256 → 64 位十六进制 */
export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS,
  )
  return bytesToHex(new Uint8Array(bits))
}

/**
 * 定长比较。普通 `===` 一撞到第一个不同的字节就返回，
 * 时间差能把「前几位对了」这件事漏出去。这里把每个字节都过一遍。
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  hashHex: string,
): Promise<boolean> {
  return safeEqual(await hashPassword(password, saltHex), hashHex)
}

async function hmac(data: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, data)
  return new Uint8Array(sig)
}

/** `v1.<payload>.<sig>`：payload 是明文 JSON（只放用户名/版本/过期，不放别的） */
export async function signSession(p: SessionPayload, secret: string): Promise<string> {
  const body = toB64url(enc.encode(JSON.stringify(p)))
  const sig = toB64url(await hmac(enc.encode(body), secret))
  return `v1.${body}.${sig}`
}

export async function readSession(
  token: string | null,
  secret: string,
): Promise<SessionPayload | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, body, sig] = parts
  const want = toB64url(await hmac(enc.encode(body), secret))
  if (!safeEqual(sig, want)) return null
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload
    if (!p || typeof p.u !== 'string' || typeof p.exp !== 'number') return null
    if (p.exp < Date.now()) return null
    return p
  } catch {
    return null
  }
}
