import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDuration, relativeTime, truncate } from './format'

afterEach(() => vi.restoreAllMocks())

describe('relativeTime', () => {
  it('formats recent values and future timestamps predictably', () => {
    const now = 1_700_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now * 1_000)

    expect(relativeTime(null)).toBe('')
    expect(relativeTime(now - 30)).toBe('刚刚')
    expect(relativeTime(now - 10 * 60)).toBe('10 分钟')
    expect(relativeTime(now - 2 * 3_600)).toBe('2 小时')
    expect(relativeTime(now - 3 * 86_400)).toBe('3 天')
    expect(relativeTime(now + 60)).toBe('刚刚')
  })
})

describe('formatDuration', () => {
  it('formats millisecond, second, and minute ranges', () => {
    expect(formatDuration(undefined)).toBe('')
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1_500)).toBe('1.5s')
    expect(formatDuration(10_000)).toBe('10s')
    expect(formatDuration(61_500)).toBe('1m 2s')
  })
})

describe('truncate', () => {
  it('normalizes whitespace before applying an ellipsis', () => {
    expect(truncate('  alpha\n beta   gamma  ')).toBe('alpha beta gamma')
    expect(truncate('abcdef', 5)).toBe('abcd…')
  })
})
