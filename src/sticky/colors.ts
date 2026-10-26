/**
 * 纸色。主进程 electron/sticky-window.ts 里有一份只含背景色的副本
 * （建窗口那一瞬要填 backgroundColor，不能等渲染层渲染完），
 * 两边的 key 必须对得上，改这里记得同步那边。
 *
 * 六种都是浅纸 + 深字，不跟系统的深色模式走：
 * 便签的隐喻就是「一张纸」，深色模式下把纸变黑，读起来是在看屏幕而不是
 * 在看便条。Windows 自带便笺也是这么处理的。
 */
export interface Paper {
  key: string
  name: string
  /** 纸面 */
  bg: string
  /** 正文 */
  fg: string
  /** 次级文字、分隔线。压得比「淡淡的灰」深一档：便签墙上的正文就是预览，
      太浅会读不动；4:1 左右的对比度在这套浅纸上是能读又不抢标题的上限 */
  dim: string
  /** 悬停底色 */
  hover: string
}

export const PAPERS: Paper[] = [
  {
    key: 'amber',
    name: '米黄',
    bg: '#fdf2d0',
    fg: '#3f3722',
    dim: '#7f7353',
    hover: '#f6e8bd',
  },
  {
    key: 'rose',
    name: '浅粉',
    bg: '#fbe3e4',
    fg: '#4a2b2e',
    dim: '#8b656d',
    hover: '#f6d6d8',
  },
  {
    key: 'mint',
    name: '薄荷',
    bg: '#e2f2e4',
    fg: '#26402b',
    dim: '#637f6a',
    hover: '#d5ebd8',
  },
  {
    key: 'sky',
    name: '天蓝',
    bg: '#e3edf9',
    fg: '#25323f',
    dim: '#64788d',
    hover: '#d6e5f5',
  },
  {
    key: 'lilac',
    name: '淡紫',
    bg: '#eee7f7',
    fg: '#362b45',
    dim: '#776a8c',
    hover: '#e5dcf2',
  },
  {
    key: 'slate',
    name: '素灰',
    bg: '#ebebeb',
    fg: '#2e2e2e',
    dim: '#6e6e6e',
    hover: '#e0e0e0',
  },
]

export function paperOf(key: string | undefined): Paper {
  return PAPERS.find((p) => p.key === key) ?? PAPERS[0]
}
