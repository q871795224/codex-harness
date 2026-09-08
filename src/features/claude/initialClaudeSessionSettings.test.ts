import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLAUDE_SESSION_SETTINGS } from '../../core/claude/types'

const runtime = vi.hoisted(() => ({
  getAppState: vi.fn(),
}))

vi.mock('../../core/runtime/bridge', () => ({ runtime }))

import { initialClaudeSessionSettings } from './initialClaudeSessionSettings'
import { CLAUDE_DEFAULT_MODEL_KEY } from './useClaudeDefaultModel'
import { CLAUDE_DEFAULT_EFFORT_KEY } from './useClaudeDefaultEffort'

function mockStored(values: Partial<Record<string, string | null>>) {
  runtime.getAppState.mockImplementation(async (key: string) => values[key] ?? null)
}

describe('initialClaudeSessionSettings', () => {
  it('returns DEFAULT_CLAUDE_SESSION_SETTINGS when nothing is stored', async () => {
    mockStored({})
    expect(await initialClaudeSessionSettings()).toEqual(DEFAULT_CLAUDE_SESSION_SETTINGS)
  })

  it('returns DEFAULT_CLAUDE_SESSION_SETTINGS when stored values are empty', async () => {
    mockStored({ [CLAUDE_DEFAULT_MODEL_KEY]: '', [CLAUDE_DEFAULT_EFFORT_KEY]: '' })
    expect(await initialClaudeSessionSettings()).toEqual(DEFAULT_CLAUDE_SESSION_SETTINGS)
  })

  it('overrides model when a default model is stored', async () => {
    mockStored({ [CLAUDE_DEFAULT_MODEL_KEY]: 'claude-opus-4-1' })
    expect(await initialClaudeSessionSettings()).toEqual({
      ...DEFAULT_CLAUDE_SESSION_SETTINGS,
      model: 'claude-opus-4-1',
    })
    expect(runtime.getAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_MODEL_KEY)
  })

  it('overrides effort when a default effort is stored', async () => {
    mockStored({ [CLAUDE_DEFAULT_EFFORT_KEY]: 'high' })
    expect(await initialClaudeSessionSettings()).toEqual({
      ...DEFAULT_CLAUDE_SESSION_SETTINGS,
      effort: 'high',
    })
    expect(runtime.getAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_EFFORT_KEY)
  })

  it('overrides model and effort together', async () => {
    mockStored({ [CLAUDE_DEFAULT_MODEL_KEY]: 'claude-opus-4-1', [CLAUDE_DEFAULT_EFFORT_KEY]: 'max' })
    expect(await initialClaudeSessionSettings()).toEqual({
      ...DEFAULT_CLAUDE_SESSION_SETTINGS,
      model: 'claude-opus-4-1',
      effort: 'max',
    })
  })

  it('falls back to DEFAULT on read failure', async () => {
    runtime.getAppState.mockRejectedValue(new Error('io'))
    expect(await initialClaudeSessionSettings()).toEqual(DEFAULT_CLAUDE_SESSION_SETTINGS)
  })
})
