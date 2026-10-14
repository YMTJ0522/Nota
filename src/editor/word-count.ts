export interface WordCount {
  chars: number;
  words: number;
  lines: number;
}

/**
 * 中文按字符算字，英文按词算字。
 *
 * 以前这里是五道正则：删空白、挑中文、删中文、切词、再逐词 `test()`。
 * 对一篇几万字的笔记，那意味着每统计一次就分配上万个字符串 —— 掉帧的来源之一。
 * 它是顶栏那个小数字的底子，每敲一个字就要重算，成本直接压在打字手感上。
 *
 * 现在改成一趟扫描、中途不分配任何字符串：
 * · 字符数＝非空白字符数（中文也算，与 `\s` 的定义一致）
 * · 中文字数＝落在 CJK 区间的字符数
 * · 英文词数＝被「空白或中文」隔开的片段中，至少含一个 ASCII 字母/数字的那些
 *
 * 语义必须跟旧写法完全一致（用户可能记着某篇多少字），
 * 所以用 scripts/diag-wordcount-equiv.mjs 拿全部 demo 笔记 + 一批边界做过对照。
 * 同一份 62KB 样本：4.91ms → 0.46ms。
 */

/** JS 的 `\s`：[\f\n\r\t\v\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff] */
function isSpace(cp: number): boolean {
  return (
    cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d ||
    cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 ||
    cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff
  )
}

const isCJK = (cp: number) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)

/** 原来那句是 `/[a-zA-Z0-9]/`，不带 u 标志，所以只认 ASCII 这 62 个 */
const isAsciiAlnum = (cp: number) =>
  (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)

/**
 * front matter 的结束位置（正文从这里开始）。没有就返回 0。
 *
 * 对应旧写法里的 `^---\n[\s\S]*?\n---\n?`：
 * `^---\n` 吃掉四个字符，所以惰性段是从**下标 4** 开始找 `\n---` 的。
 * 写成 3 的话，像 `---\n---\n` 这种紧贴的会被误当成 front matter 抠掉。
 */
function bodyStart(text: string): number {
  if (
    text.charCodeAt(0) === 45 && text.charCodeAt(1) === 45 &&
    text.charCodeAt(2) === 45 && text.charCodeAt(3) === 10
  ) {
    const close = text.indexOf("\n---", 4)
    if (close >= 0) {
      let end = close + 4
      if (text.charCodeAt(end) === 10) end++
      return end
    }
  }
  return 0
}

export function countWords(text: string): WordCount {
  if (!text) return { chars: 0, words: 0, lines: 0 };

  const start = bodyStart(text)
  let chars = 0;
  let chinese = 0;
  let english = 0;
  let lines = 1;
  /** 当前片段里有没有出现过字母/数字——决定它算不算一个「词」 */
  let hasAlnum = false;

  for (let i = start; i < text.length; i++) {
    const cp = text.charCodeAt(i)
    const cjk = isCJK(cp)

    if (!isSpace(cp)) chars++
    if (cjk) chinese++

    /* 中文被当成空格 sep：旧写法是先把中文替换成空格再切词，
       所以这里中文跟空白一样起着分隔作用。 */
    if (cjk || isSpace(cp)) {
      if (hasAlnum) english++
      hasAlnum = false
    } else if (isAsciiAlnum(cp)) {
      hasAlnum = true
    }

    if (cp === 0x0a) lines++
  }
  if (hasAlnum) english++

  return { chars, words: chinese + english, lines };
}

export function formatWordCount(count: WordCount): string {
  return `${count.words} 字 · ${count.chars} 字符 · ${count.lines} 行`;
}
