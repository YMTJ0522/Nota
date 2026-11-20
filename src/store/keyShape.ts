/**
 * 密钥形状判断。
 *
 * 为什么需要：真实事故——从 Ollama 换到智谱时，把模型名
 * `qwen2.5-coder:7b-instruct-q4_K_M` 粘进了 API Key 框。接口一直回 401，
 * 界面上只有一句「身份验证失败」，用户根本看不出是自己填错了格。
 *
 * 这里的判断只用于**当场提示**（输完就能看见红字），真正的报错文案在
 * 主进程里另有一份（electron/main.ts 的 keyLooksLikeModel）——渲染层不能
 * import 主进程代码。两份的结果由 scripts/verify-key-hint.mjs 对齐，防止
 * 改了一份忘了另一份。
 */

/** 各家密钥的典型形状，给用户一个「应该长这样」的参照 */
export const KEY_SHAPE: Record<string, string> = {
  'https://api.openai.com/v1': 'sk-…',
  'https://api.deepseek.com/v1': 'sk-…',
  'https://api.moonshot.cn/v1': 'sk-…',
  'https://open.bigmodel.cn/api/paas/v4': '一串字符加一个点，如 xxxx.yyyy',
  'https://api.siliconflow.cn/v1': 'sk-…',
}

/**
 * 这个字符串更像模型名还是密钥。
 *
 * - 含冒号基本可断定是模型名：冒号是 Ollama 模型的 tag 分隔符（qwen2.5:7b），
 *   而各家密钥里都不含冒号
 * - 以 sk- 开头或含点时按密钥处理，不误伤
 * - 剩下的看品牌前缀：glm-4-flash、llama3 这类填进密钥框是常见笔误
 */
export function keyLooksLikeModel(key: string): boolean {
  const k = (key ?? '').trim()
  if (!k) return false
  if (k.includes(':')) return true
  const skStyle = /^sk-/i.test(k) || k.includes('.')
  if (skStyle) return false
  return /^(qwen|llama|gemma|glm|mistral|deepseek|phi|codellama|yi|cogito)/i.test(k)
}
