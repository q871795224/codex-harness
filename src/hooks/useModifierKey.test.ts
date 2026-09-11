// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useModifierKey } from './useModifierKey'

afterEach(cleanup)

describe('useModifierKey', () => {
  it('returns false by default', () => {
    const { result } = renderHook(() => useModifierKey('Meta'))
    expect(result.current).toBe(false)
  })

  it('tracks Meta key press and release', () => {
    const { result } = renderHook(() => useModifierKey('Meta'))
    expect(result.current).toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }))
    })
    expect(result.current).toBe(true)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }))
    })
    expect(result.current).toBe(false)
  })

  it('tracks Control key press and release', () => {
    const { result } = renderHook(() => useModifierKey('Control'))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }))
    })
    expect(result.current).toBe(true)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    })
    expect(result.current).toBe(false)
  })

  it('ignores unrelated keys', () => {
    const { result } = renderHook(() => useModifierKey('Meta'))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(result.current).toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }))
    })
    expect(result.current).toBe(false)
  })

  it('resets when the window loses focus', () => {
    const { result } = renderHook(() => useModifierKey('Meta'))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }))
    })
    expect(result.current).toBe(true)

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current).toBe(false)
  })

  it('stops listening after unmount', () => {
    const { result, unmount } = renderHook(() => useModifierKey('Meta'))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }))
    })
    expect(result.current).toBe(true)

    unmount()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }))
    })
    // After unmount, the listeners should be removed. We just verify no errors.
    expect(result.current).toBe(true)
  })
})
