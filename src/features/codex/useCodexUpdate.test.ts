import { describe, expect, it } from 'vitest'
import type { CodexUpdateStatus } from '../../core/codex-update/types'
import { shouldShowCodexUpdate } from './useCodexUpdate'

const available: CodexUpdateStatus = {
  currentVersion: '0.150.1',
  appServerVersion: '0.150.1',
  latestVersion: '0.151.0',
  updateAvailable: true,
  skipped: false,
  lastCheckedAt: 1,
  checkError: null,
}

describe('shouldShowCodexUpdate', () => {
  it('shows an available update on an empty thread until that thread defers it', () => {
    expect(shouldShowCodexUpdate(available, 'thread-1', new Set())).toBe(true)
    expect(shouldShowCodexUpdate(available, 'thread-1', new Set(['thread-1']))).toBe(false)
    expect(shouldShowCodexUpdate(available, 'thread-2', new Set(['thread-1']))).toBe(true)
  })

  it('does not show a skipped or already installed version', () => {
    expect(shouldShowCodexUpdate({ ...available, skipped: true }, 'thread-1', new Set())).toBe(false)
    expect(shouldShowCodexUpdate({ ...available, updateAvailable: false }, 'thread-1', new Set())).toBe(false)
    expect(shouldShowCodexUpdate(available, null, new Set())).toBe(false)
  })
})
