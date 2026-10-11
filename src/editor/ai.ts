/**
 * AI 编写动作。
 *
 * 四种动作覆盖写作里最常见的四件事：续写、润色、总结、翻译。
 * 之所以不做成「自由输入框 + 发送」，是因为笔记写作时的需求高度重复，
 * 点一下就能拿到结果比每次组织提示词更快；真要自定义可以改系统提示词。
 *
 * 取文本的规则：有选区就用选区，没有就取光标前面的一段当作上下文。
 * 总结/润色/翻译都要求先有对象，续写在空文档上也能工作（等于凭空起头）。
 */
import type { EditorView } from '@codemirror/view'
import { store } from '@/store'

export type AiAction = 'continue' | 'polish' | 'summarize' | 'translate'

/** 没选区时往上取多少字符当上下文。再长对本地模型就是负担了 */
const CONTEXT_CHARS = 2000

const INSTRUCTION: Record<AiAction, string> = {
  continue: '接着下面的内容继续写。只输出续写部分，不要重复已有内容，不要加解释。',
  polish: '润色下面的文字：修正语病、让表达更顺，保留原意与 Markdown 格式。只输出结果。',
  summarize: '把下面的内容总结成 Markdown 要点列表，抓住结论与关键事实。只输出结果。',
  translate: '把下面的内容翻译成通顺的中文，保留 Markdown 结构与专有名词。只输出结果。',
}

/** 每个动作对「有选区」的依赖程度不同：续写可以凭空写，其余必须有对象 */
const NEEDS_SELECTION: Record<AiAction, boolean> = {
  continue: false,
  polish: true,
  summarize: true,
  translate: true,
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

function contextOf(view: EditorView, action: AiAction): { text: string; from: number; to: number } {
  const range = view.state.selection.main
  const selected = view.state.sliceDoc(range.from, range.to)
  if (selected.trim()) return { text: selected, from: range.from, to: range.to }

  // 没有选区：取光标前的一段当上下文，插入点就在光标处
  const from = Math.max(0, range.from - CONTEXT_CHARS)
  return { text: view.state.sliceDoc(from, range.from), from: range.from, to: range.from }
}

export async function runAi(view: EditorView, action: AiAction): Promise<void> {
  const cfg = store.state.ai
  if (!cfg.baseUrl.trim() || !cfg.model.trim()) {
    toast('先在设置 › AI 里填好接口地址和模型')
    return
  }

  const ctx = contextOf(view, action)
  if (!ctx.text.trim() && NEEDS_SELECTION[action]) {
    const what = action === 'translate' ? '翻译' : action === 'polish' ? '润色' : '总结'
    toast(`先选中要${what}的文字`)
    return
  }

  const prompt = ctx.text.trim()
    ? `${INSTRUCTION[action]}\n\n${ctx.text}`
    : INSTRUCTION[action]

  toast('AI 处理中…')
  const res = await window.api.aiChat(cfg, [{ role: 'user', content: prompt }])
  if (!res.ok || !res.text) {
    toast(`AI 调用失败：${res.error ?? '未知错误'}`)
    return
  }

  const out = res.text.trim()
  if (!out) {
    toast('AI 返回了空内容')
    return
  }

  // 润色和翻译是「替换」，续写和总结是「追加」——后者保留原文是有意的
  const replace = action === 'polish' || action === 'translate'
  const lead = replace ? '' : ctx.from === ctx.to ? '\n' : '\n\n'
  const insert = replace ? out : lead + out

  view.dispatch({
    changes: { from: ctx.from, to: ctx.to, insert },
    selection: { anchor: ctx.from + insert.length },
    userEvent: 'input.ai',
  })
  view.focus()
  toast('已插入 AI 结果')
}
