/**
 * 双链的解析规则，只有这一份。
 *
 * 预览里点 `[[…]]` 要跳到那一篇、关系图要连线、旁边那一栏要列出来 ——
 * 三处都得回答同一个问题：「这个名字对应工作区里哪一篇」。以前这条规则
 * 只写在编辑区里，别处要用就得再抄一遍；抄出来的东西迟早和原版不一致，
 * 表现成「预览里点得动、图里连不上」这种没头没尾的 bug。所以抽到这里，
 * 谁要谁引，规则只改一处。
 */

/** 只需要这两样：路径用来比对、名字用来兜底猜 */
export interface NoteRef {
  path: string
  name: string
}

/**
 * `[[名字]]` 里的名字对应工作区里哪一篇。
 *
 * 名字不带目录，所以按 Obsidian 那套顺次试：
 *  1. 把名字当成「相对库根的路径」去比对（`日记/2026-01`，或者就一篇
 *     躺在库根下的 `读书笔记`）—— 命中就是它，重名时这一条也能定下来；
 *  2. 全库只有一个叫这个名字的笔记 —— 就是它；
 *  3. 重名且一篇都不在库根 —— 不许猜。猜错了跳到别的笔记上去，人得
 *     回头翻半天才知道自己刚才去了哪儿，还不如明着说找不着。
 */
export function resolveWikiNote(
  name: string,
  files: readonly NoteRef[],
  root: string | null,
): string | null {
  const want = name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '')
  const rootRel = (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  /* 第一档是**路径形式**，重名的时候全靠它（补全遇到重名插的就是路径）。
     注意 root 里的反斜杠要统一成 `/` 而不是删掉：删掉会拼出
     `C:Users…笔记.md` 这种四不像，一条也命中不了。 */
  if (rootRel) {
    const full = `${rootRel}/${want}.md`
    const hit = files.find((f) => f.path.replace(/\\/g, '/').toLowerCase() === full)
    if (hit) return hit.path
  }
  /* 带目录的名字退回只用末段去猜：`日记/2026-01` 没命中路径时，
     全库只有一篇 `2026-01` 也认它 —— 人写目录名常常写错一个字。 */
  const base = want.slice(want.lastIndexOf('/') + 1).toLowerCase()
  const sameBase = files.filter((f) => f.name.replace(/\.md$/i, '').toLowerCase() === base)
  return sameBase.length === 1 ? sameBase[0].path : null
}

/** 一条指向别处的链接 */
export interface OutLink {
  /** 写出来的原样（去掉别名和锚点），用来显示、也用来再解析 */
  target: string
  /** `|` 后面的别名，有就显示它 */
  alias?: string
  /** 是不是 `![[…]]` 嵌入。嵌入比普通链接更强，值得在列表里标出来 */
  embed: boolean
}

/**
 * 正文里所有指向别的笔记的链接，按出现顺序。
 *
 * 三种写法都认，因为编辑器自己就会产出这几种：
 *   `[[名字]]`、`[[目录/名字|别名]]`、`[[名字#^块]]`、`![[名字]]`、`[文字](路径.md)`。
 *
 * 两处刻意排除：
 *  - `[[#^块]]`（只有锚点）是**本篇内部**的跳转，不指向别的笔记；
 *  - `http(s)://…` 是外面的世界，不是工作区里的一篇。
 *
 * 重复的按「目标 + 别名」去重但保留首次出现的位置：一篇里提同一篇笔记
 * 五次，列表里只该有一行 —— 这一栏回答的是「链到了谁」，不是「提了几次」。
 */
export function outgoingLinks(text: string): OutLink[] {
  const out: OutLink[] = []
  const seen = new Set<string>()
  const push = (l: OutLink) => {
    const k = `${l.embed ? '!' : ''}${l.target}|${l.alias ?? ''}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(l)
  }

  /* 先把代码块整段挖掉：里面的 `[[…]]` 是示例文本，不是链接。
     用等长空白替换而不是删掉，这样行号、后续正则的位置都不受影响。 */
  const masked = text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\$\$[\s\S]*?\$\$/g, (m) => m.replace(/[^\n]/g, ' '))

  for (const m of masked.matchAll(/(!?)\[\[([^\[\]\n]+)\]\]/g)) {
    const embed = m[1] === '!'
    const inner = m[2].trim()
    /* `[[#^abc]]` / `[[#标题]]`：只带锚点，指的是本篇自己 */
    if (!inner || inner.startsWith('#')) continue
    const [head, ...rest] = inner.split('|')
    const target = head.split('#')[0].trim()
    if (!target) continue
    push({ target, alias: rest.join('|').trim() || undefined, embed })
  }

  for (const m of masked.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*([^)\s]+?)\s*\)/g)) {
    const href = m[1]
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) continue
    const path = href.split('#')[0]
    if (!/\.md$/i.test(path)) continue
    push({ target: path.replace(/\.md$/i, ''), embed: false })
  }

  return out
}
