/**
 * 折叠状态按笔记记住。
 *
 * 放在模块级的 Map 里而不是 store、也不落盘：这是一份「这次开着窗口时
 * 我怎么看这篇」的临时状态，跟便签那种用户数据不是一回事。写进
 * settings.json 会多出一堆没人在意的 id，换台机器同步过去更是莫名其妙。
 * 关掉应用就忘，符合预期。
 *
 * key 用笔记路径；节点 id 会因为改标题而变（标题 slug 从文字生成），
 * 变了的那些自然重新展开 —— 这是对的：标题都改了，原来的「收起」也没意义了。
 */

const memo = new Map<string, Set<string>>()

export function loadFolds(path: string | null): Set<string> {
  return new Set(memo.get(path ?? '') ?? [])
}

export function saveFolds(path: string | null, folds: Set<string>) {
  if (!path) return
  if (folds.size === 0) memo.delete(path)
  else memo.set(path, new Set(folds))
}
