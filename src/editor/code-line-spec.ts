/**
 * 代码块 info 串里 `{…}` 那一段的读写。
 *
 * 写和读必须共用这一份：编辑器里按它算「现在标了哪几行、再点一下该变成什么」，
 * 预览里按同一套规则决定哪几行铺底色。两边各写一份的话迟早分叉，
 * 而分叉出来的症状是最难查的那种——编辑器里明明标上了，预览里一点反应都没有。
 */

/** 一屏代码不可能有这么多行，超出多半是手滑（`{1-99999}`） */
const MAX_LINE = 9999;

/** `2`、`2,4-6`、`1-3, 7, 9-12` → 行号集合（1 起） */
export function parseLineSpec(spec: string): Set<number> {
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (to < from) continue;
    for (let i = from; i <= to && i <= MAX_LINE; i += 1) set.add(i);
  }
  return set;
}

/**
 * 行号集合 → 写进 `{…}` 的字符串。
 *
 * 相邻两行以上一律合并成区间。`3,4` 和 `3-4` 一样长，但写出来的东西
 * 得和「选中两行点一下」这个动作长得像——人是框住一段，不是勾两个方框。
 * 两段以上也是同一个道理：`2-3,7` 一眼能看出「一段加一行」。
 */
export function formatLineSpec(lines: Iterable<number>): string {
  const nums = [...lines].filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);
  const out: string[] = [];
  let at = 0;
  while (at < nums.length) {
    let end = at;
    while (end + 1 < nums.length && nums[end + 1] === nums[end] + 1) end += 1;
    const span = end - at + 1;
    out.push(span >= 2 ? `${nums[at]}-${nums[end]}` : `${nums[at]}`);
    at = end + 1;
  }
  return out.join(",");
}
