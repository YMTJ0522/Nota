/**
 * AI 对话记录的落盘。
 *
 * 单独一份 `<库>/.nota/chat.json`，不跟设置混在一起：它长得快（一轮回答
 * 就能有几千字），而设置是「拖一下分隔线就写一次」的碎片操作。混在一起的话，
 * 每次调宽度都要把几十万字的对话重写一遍。
 *
 * 它跟库走 —— 换台电脑打开同一个库，AI 那边的历史对话还在。
 */
type ChatData = { active?: number; sessions?: unknown[] }

let root: string | null = null
let pending: ChatData | null = null
let timer: ReturnType<typeof setTimeout> | null = null

export async function loadChat(next: string | null): Promise<ChatData> {
  await flushChatAsync()
  root = next
  try {
    const r = await window.api.settingsRead(next, 'chat')
    const data = r?.data
    if (data && typeof data === 'object') return data as ChatData
  } catch {
    /* 读不出来就当没有历史 */
  }
  return {}
}

/** 记一笔。攒 800ms 写一次：流式回答期间不会反复落盘 */
export function saveChat(data: ChatData): void {
  pending = data
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void flushChatAsync()
  }, 800)
}

async function flushChatAsync(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  const data = pending
  pending = null
  if (!data) return
  try {
    await window.api.settingsPatch(root, data as Record<string, unknown>, 'chat')
  } catch {
    /* 写不进去就留在内存里，这一轮对话照样能继续 */
  }
}

/** 退出前的同步兜底。IPC 是异步的，这里只能尽力发出去 */
export function flushChat(): void {
  void flushChatAsync()
}
