/**
 * 版本号比较。
 *
 * 单独成文件是为了能单测：`update.ts` 要 import electron 拿 `net.fetch`，
 * 一 import 就没法在普通 node 里跑起来；这个函数是纯的，抽出来才断言得了。
 * 而版本比较恰恰是那种「写错了界面看不出任何异常」的代码 ——
 * 用户只会觉得「明明有新版，它却说已是最新」。
 */

/**
 * 逐段比数字：`2.7.10` 比 `2.7.9` 新 —— 直接比字符串会得出相反结论，
 * 这是这类判断最经典的一个坑。
 *
 * 非数字段（`-beta`、`.rc1`）按 0 算。这里不做完整的 semver 预发布语义，
 * 因为 Nota 从来不发行带后缀的版本；真哪天要发，得先把这段补完整。
 *
 * 返回：a 新于 b → 1，相同 → 0，旧于 → -1。
 */
export function compareVersion(a: string, b: string): number {
  const seg = (v: string): number[] =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((s) => Number.parseInt(s, 10) || 0)

  const x = seg(a)
  const y = seg(b)
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}
