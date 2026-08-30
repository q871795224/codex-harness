import { describe, expect, it } from 'vitest'
import { resolveQuickPanelAnchor } from './quickPanelLayout'

describe('quick panel layout', () => {
  it('falls back to the dock position when the active tab has no composer', () => {
    expect(resolveQuickPanelAnchor(false, 176)).toBeUndefined()
  })

  it('tracks the measured composer position when the composer is visible', () => {
    expect(resolveQuickPanelAnchor(true, 92)).toBe(92)
  })
})
