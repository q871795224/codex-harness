export function relativeTime(seconds: number | null | undefined): string {
  if (!seconds) return ''
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - seconds))
  if (delta < 60) return '刚刚'
  if (delta < 3_600) return `${Math.floor(delta / 60)} 分钟`
  if (delta < 86_400) return `${Math.floor(delta / 3_600)} 小时`
  if (delta < 86_400 * 7) return `${Math.floor(delta / 86_400)} 天`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(seconds * 1000))
}

export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return ''
  if (milliseconds < 1_000) return `${milliseconds}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`
}

export function truncate(value: string, length = 96): string {
  const normalised = value.replace(/\s+/g, ' ').trim()
  return normalised.length > length ? `${normalised.slice(0, length - 1)}…` : normalised
}
