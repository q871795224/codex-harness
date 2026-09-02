import { describe, expect, it } from 'vitest'
import { capabilitiesForProvider } from './useUnifiedHarness'

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
