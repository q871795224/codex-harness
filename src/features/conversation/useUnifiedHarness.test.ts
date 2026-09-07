import { describe, expect, it } from 'vitest'
import { capabilitiesForProvider, shouldGenerateClaudeTitle } from './useUnifiedHarness'

describe('conversation provider capabilities', () => {
  it('exposes Claude follow-up controls alongside its supported features', () => {
    expect(capabilitiesForProvider('claude')).toMatchObject({
      images: true,
      approvals: true,
      interrupt: true,
      resume: true,
      queue: true,
      steer: true,
      fork: false,
      skills: false,
      mcpManagement: false,
    })
  })

  it('preserves the existing Codex controls', () => {
    expect(capabilitiesForProvider('codex')).toMatchObject({
      queue: true,
      steer: true,
      fork: true,
      skills: true,
      mcpManagement: true,
    })
  })
})

describe('Claude automatic title eligibility', () => {
  it('only titles a new untouched Claude session', () => {
    expect(shouldGenerateClaudeTitle('Claude 会话', null, false)).toBe(true)
    expect(shouldGenerateClaudeTitle('手工标题', null, false)).toBe(false)
    expect(shouldGenerateClaudeTitle('Claude 会话', 'provider-session', false)).toBe(false)
    expect(shouldGenerateClaudeTitle('Claude 会话', null, true)).toBe(false)
  })
})
