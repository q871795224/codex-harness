// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextRing } from './Composer'

afterEach(cleanup)

describe('ContextRing hover tooltip', () => {
  it('不使用 native title，用自绘 tooltip 展示占用', () => {
    const usage = {
      contextTokens: 100_000,
      modelContextWindow: 256_000,
      last: { totalTokens: 100_000 },
    } as never

    const { container } = render(<ContextRing usage={usage} provider="codex" />)

    // 不应该有 native title
    const ring = container.querySelector('.context-ring')
    expect(ring?.getAttribute('title')).toBeNull()

    // 应该有自绘 tooltip 元素
    const tooltip = container.querySelector('.context-ring-tooltip')
    expect(tooltip).toBeTruthy()
    expect(tooltip?.textContent).toContain('100K')
    expect(tooltip?.textContent).toContain('256K')

    // 保留 aria-label
    expect(ring?.getAttribute('aria-label')).toContain('100K')
  })
})
