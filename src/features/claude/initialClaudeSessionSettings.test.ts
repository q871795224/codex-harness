import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLAUDE_SESSION_SETTINGS } from '../../core/claude/types'

const runtime = vi.hoisted(() => ({
  getAppState: vi.fn(),
}))

vi.mock('../../core/runtime/bridge', () => ({ runtime }))

import { initialClaudeSessionSettings } from './initialClaudeSessionSettings'
import { CLAUDE_DEFAULT_MODEL_KEY } from './useClaudeDefaultModel'

describe('initialClaudeSessionSettings', () => {
  it('returns DEFAULT_CLAUDE_SESSION_SETTINGS when no default model is stored', async () => {
    runtime.getAppState.mockResolvedValue(null)
    expect(await initialClaudeSessionSettings()).toEqual(DEFAULT_CLAUDE_SESSION_SETTINGS)
  })

  it('returns DEFAULT_CLAUDE_SESSION_SETTINGS when stored model is empty', async () => {
    runtime.getAppState.mockResolvedValue('')
    expect(await initialClaudeSessionSettings()).toEqual(DEFAULT_CLAUDE_SESSION_SETTINGS)
  })

  it('overrides model when a default model is stored', async () => {
    runtime.getAppState.mockResolvedValue('claude-opus-4-1')
    expect(await initialClaudeSessionSettings()).toEqual({
      ...DEFAULT_CLAUDE_SESSION_SETTINGS,
      model: 'claude-opus-4-1',
    })
    expect(runtime.getAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_MODEL_KEY)
  })

  it('falls back to DEFAULT on read failure', async () => {
    runtime.getAppState.mockRejectedValue(new Error('io'))
    expect(await initialClaudeSessionSettings()).toEqual(DEFAULT_CLAUDE_SESSION_SETTINGS)
  })
})
