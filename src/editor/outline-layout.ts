/**
 * 把结构树排成一张横向导图。
 *
 * 刻意不复用 `GraphView` 那套斥力弹簧：那是一张「力导向图」，每次打开位置
 * 都不太一样，适合看整体形状；而导图是**读结构**的，同一篇笔记今天和明天
 * 必须长得一模一样，否则「我上次在左下角看到的那一节」就找不回来了。
 * 所以这里用确定性的 tidy-tree：先自底向上算子树占多高，再自顶向下分配 y。
 *
 * 坐标从 (0,0) 开始，由调用方决定怎么平移；这样布局本身与容器大小无关。
 */

import type { OutlineNode } from './outline-tree'

/** 单个节点的固定行高：导图节点一律一行，长了就省略 */
export const NODE_H = 30
export const ROOT_H = 36
/** 同层相邻节点的最小垂直间距 */
const V_GAP = 10
/** 层与层之间的水平间距 */
const H_GAP = 54
/* 节点内左右内边距之和。
   实测下来 24 偏小：`.mn` 是 padding 0 8px 0 10px（18）加上文字与图标的
   gap（6），八到九个字的标题就会挤到省略号。给到 32 正好。 */
const PAD = 32
const MIN_W = 84
const MAX_W = 268

export interface LayoutNode {
  node: OutlineNode
  x: number
  y: number
  w: number
  h: number
  depth: number
  collapsed: boolean
  hasChildren: boolean
  /** 全部后代数量（不受折叠影响），折叠标记上显示「还有几项」 */
  hidden: number
}

export interface LayoutEdge {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface LayoutResult {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
  /** 因为超过上限被丢掉的数量，0 表示全画出来了 */
  dropped: number
}

/**
 * 估一行文字的宽度。
 *
 * 不引 measureText：那要建一个离屏 canvas，且在布局函数里做 DOM 相关的
 * 事会让这个模块没法在纯 Node 环境里跑测试。中文按一个字宽、西文按
 * 约 0.55 个字宽估算，误差在几个像素内 —— 节点本身有省略号，差几像素
 * 看不出来，而布局的确定性比像素级的准更重要。
 */
function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字、全角标点、假名、韩文
    const wide =
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x3000 && c <= 0x303f)
    w += wide ? size : size * 0.55
  }
  return w
}

function widthOf(n: OutlineNode, depth: number): number {
  const size = depth === 0 ? 13.5 : depth === 1 ? 13 : 12.5
  let w = textWidth(n.text, size) + PAD
  if (n.tag) w += textWidth('#' + n.tag, 10.5) + 16
  w += 26 // 折叠圆钮（18）与它的 gap；没有子节点也留，同层宽度才不会跳
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(w)))
}

function heightOf(n: OutlineNode): number {
  return n.depth === 0 ? ROOT_H : NODE_H
}

/**
 * 排出坐标。
 *
 * `collapsed` 里是**被收起**的节点 id。根节点不允许收起（收起来就只剩一个点）。
 * `maxNodes` 是硬上限：超长的笔记只画前面这些，并在返回值里如实报告丢了多少。
 */
export function layoutTree(
  root: OutlineNode,
  collapsed: Set<string>,
  maxNodes = 400,
): LayoutResult {
  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []
  let dropped = 0

  /* 先按先序收一遍「看得见的节点」，顺带算每个节点的列宽。
     折叠的节点本身要画（上面带数字），它的子节点不画。 */
  const colMax: number[] = []
  const visit = (n: OutlineNode, depth: number, parentVisible: boolean) => {
    if (!parentVisible) return
    if (nodes.length >= maxNodes) {
      dropped += 1
      return
    }
    const isCollapsed = n.depth > 0 && collapsed.has(n.id)
    const w = widthOf(n, depth)
    colMax[depth] = Math.max(colMax[depth] ?? 0, w)
    const children = isCollapsed ? [] : n.children
    nodes.push({
      node: n,
      x: 0,
      y: 0,
      w,
      h: heightOf(n),
      depth,
      collapsed: isCollapsed,
      hasChildren: n.children.length > 0,
      // 收起时才知道「里面还压着几项」——这个数字要画在折叠标记上
      hidden: isCollapsed ? descendCount(n) : 0,
    })
    for (const c of children) visit(c, depth + 1, true)
  }
  visit(root, 0, true)

  /* 列宽对齐：同一层用这一层最宽的那个当列宽，左边缘齐，
     层与层之间的水平间距才看得出是「一级」。 */
  const colX: number[] = [0]
  for (let d = 0; d < colMax.length; d++) {
    colX[d + 1] = colX[d] + (colMax[d] ?? MIN_W) + H_GAP
  }
  for (const ln of nodes) ln.x = colX[ln.depth]
  /* 节点宽度保持贴合文字，**不要**补齐到列宽。
     补齐过一次，结果「随机记」这种两个字的节点占了一条长条，右边一大片空白，
     折叠按钮浮在很远的地方，一串节点看着像没填满的表格。列起点已经按本层
     最宽的那个算过了，短节点右侧留白由连线自己走过去，反而更像树。 */

  /* 自底向上量子树高度（用递归算，节点数几百，栈不会爆） */
  const heightCache = new Map<string, number>()
  const subHeight = (n: OutlineNode, isCollapsed: boolean): number => {
    if (isCollapsed || n.children.length === 0) return heightOf(n)
    const cached = heightCache.get(n.id)
    if (cached !== undefined) return cached
    let total = 0
    for (const c of n.children) {
      total += subHeight(c, collapsed.has(c.id)) + V_GAP
    }
    const h = Math.max(heightOf(n), total - V_GAP)
    heightCache.set(n.id, h)
    return h
  }

  /* 自顶向下分配 y：父节点对齐「第一个子节点中心」到「最后一个子节点中心」
     的中点。比按子树几何中心对齐更稳 —— 子节点数不均时几何中心会偏。 */
  const byId = new Map<string, LayoutNode>()
  for (const ln of nodes) byId.set(ln.node.id, ln)

  let cursor = 0
  const place = (n: OutlineNode): number => {
    const ln = byId.get(n.id)
    if (!ln) return 0
    const h = subHeight(n, ln.collapsed)
    if (ln.collapsed || n.children.length === 0) {
      ln.y = cursor + (h - ln.h) / 2
      cursor += h + V_GAP
      return h
    }
    let firstY = 0
    let lastY = 0
    for (let i = 0; i < n.children.length; i++) {
      const cy = cursor
      const ch = place(n.children[i])
      const childLn = byId.get(n.children[i].id)
      if (childLn) {
        if (i === 0) firstY = childLn.y
        lastY = childLn.y
      }
      cursor = cy + ch + V_GAP
    }
    ln.y = (firstY + lastY) / 2
    return h
  }
  place(root)

  /* 把 y 归一：第一个节点顶到 0（place 已经从 0 开始，但根对齐后可能为负） */
  let minY = Infinity
  let maxY = -Infinity
  let maxX = 0
  for (const ln of nodes) {
    minY = Math.min(minY, ln.y)
    maxY = Math.max(maxY, ln.y + ln.h)
    maxX = Math.max(maxX, ln.x + ln.w)
  }
  if (!Number.isFinite(minY)) minY = 0
  /* 坐标取整要在连线之前：父节点 y 是子节点的中点，一路除下来全是小数，
     小数坐标画出来的文字和 1px 连线都是亚像素模糊 —— 导图发糊一半是它。
     在源头取整，节点和连线共用同一套整数，永远对得齐。 */
  for (const ln of nodes) {
    ln.y = Math.round(ln.y - minY)
  }
  /* 连线：父的右边缘中点 → 子的左边缘中点。折线在渲染层画，这里只给端点 */
  for (const ln of nodes) {
    if (ln.collapsed) continue
    for (const c of ln.node.children) {
      const cl = byId.get(c.id)
      if (!cl) continue
      edges.push({
        x1: ln.x + ln.w,
        y1: ln.y + ln.h / 2,
        x2: cl.x,
        y2: cl.y + cl.h / 2,
      })
    }
  }

  return {
    nodes,
    edges,
    width: maxX,
    height: Math.max(...nodes.map((ln) => ln.y + ln.h), 0),
    dropped,
  }
}

/**
 * 统计某节点下所有后代的数量（含折叠的），给折叠标记上的数字用。
 * 单独放出来是为了让渲染层不必自己递归。
 */
export function descendCount(n: OutlineNode): number {
  let c = 0
  for (const ch of n.children) c += 1 + descendCount(ch)
  return c
}
