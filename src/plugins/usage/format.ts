export function formatTokens(value: number): string {
  const unit = value >= 1e9 ? [1e9, 'B'] as const : value >= 1e6 ? [1e6, 'M'] as const : value >= 1e3 ? [1e3, 'K'] as const : [1, ''] as const
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: unit[0] === 1 ? 0 : 2 }).format(value / unit[0])}${unit[1]}`
}
export const cacheRate = (input: number, cached: number) => input > 0 ? `${(cached / input * 100).toFixed(1)}%` : '—'
export const workspaceName = (path: string) => path.split('/').filter(Boolean).at(-1) || '工作区未记录'
export const modelName = (model: string | null) => model || '未记录模型'
export const MODEL_COLORS = ['#387d68', '#577db9', '#bf8545', '#9372ac', '#bf6464', '#688b9a', '#919153', '#a37867']
export const modelColor = (model: string | null, availableModels: string[]) => {
  const index = model === null ? availableModels.length : availableModels.indexOf(model)
  return MODEL_COLORS[index] ?? `hsl(${((index + 1) * 137.5) % 360} 45% 52%)`
}
export function calendarDays(since: string, until: string): string[] {
  const days: string[] = []
  const date = new Date(`${since}T00:00:00`)
  while (days.length < 366 && Number.isFinite(+date)) {
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    if (value > until) break
    days.push(value)
    date.setDate(date.getDate() + 1)
  }
  return days
}
