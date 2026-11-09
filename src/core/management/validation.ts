export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象')
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: string[], nonempty = false) {
  if (nonempty && !Object.keys(value).length) throw new Error('更新内容不能为空')
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`不支持的配置字段: ${key}`)
}
export function string(value: unknown, name: string, max = 100_000, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw new Error(`${name} 文本无效`)
  return value.trim()
}
export function choice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${name} 须为 ${allowed.join(' / ')}`)
  return value as T
}
export function number(value: unknown, min: number, max: number, name: string, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) throw new Error(`${name} 须为 ${min}–${max}${integer ? ' 的整数' : ''}`)
  return value
}
export function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是布尔值`)
  return value
}
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, i) => sameJson(value, right[i]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}
