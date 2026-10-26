/**
 * 便签在列表和墙上共用的时间写法。
 *
 * 粗粒度就够了：便签是「刚才随手记的东西」，没人关心它是三分钟前还是四分钟前。
 * 同一天里用「几小时前」，跨年才落到年月日 —— 中间那档写「9月3日」比
 * 「23 天前」更好认，人回忆事情是按日期的。
 */
export function relTime(ts: number): string {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  const dt = new Date(ts)
  if (dt.getFullYear() === new Date().getFullYear())
    return `${dt.getMonth() + 1}月${dt.getDate()}日`
  return `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`
}
