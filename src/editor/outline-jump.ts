/**
 * 「点了大纲 / 导图里的一个节点」→ 让人回到正文那一行。
 *
 * 大纲和导图是两个组件，但点下去要做的是同一件事：高亮、滚预览、滚编辑区。
 * 那套逻辑已经在编辑区挂着的 `nota:heading` 事件里了（它是给旧大纲写的），
 * 与其再开一条通道、把那堆滚动换算抄第二遍，不如两个视图都发同一个事件 ——
 * 两份滚动算法只要有一处不一致，点标题和点列表项就会落到两个位置。
 *
 * 列表项没有预览锚点，事件里带的是**行号**：编辑区按行号滚，找不到对应
 * 元素时用行号在标题之间插值去滚预览，见 `onHeadingRequest`。
 */

import type { OutlineNode } from './outline-tree'

export function jumpToOutlineNode(n: OutlineNode) {
  window.dispatchEvent(
    new CustomEvent('nota:heading', {
      detail: { id: n.id, level: n.level, text: n.text, line: n.line },
    }),
  )
}
