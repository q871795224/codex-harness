import { describe, expect, it } from 'vitest'
import { resolveQuickPanelAnchor, shouldShowQuickPanels } from './quickPanelLayout'

describe('quick panel layout', () => {
  it('falls back to the dock position when the active tab has no composer', () => {
    expect(resolveQuickPanelAnchor(false, 176)).toBeUndefined()
  })

  it('tracks the measured composer position when the composer is visible', () => {
    expect(resolveQuickPanelAnchor(true, 92)).toBe(92)
  })

  it('keeps quick panels in sync with the composer', () => {
    expect(shouldShowQuickPanels(true, true)).toBe(true)
    expect(shouldShowQuickPanels(true, false)).toBe(false)
    expect(shouldShowQuickPanels(false, true)).toBe(false)
  })
})
