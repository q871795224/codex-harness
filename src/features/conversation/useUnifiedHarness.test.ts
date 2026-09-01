import { describe, expect, it } from 'vitest'
import { capabilitiesForProvider } from './useUnifiedHarness'

describe('conversation provider capabilities', () => {
  it('keeps Claude phase-one features explicit', () => {
    expect(capabilitiesForProvider('claude')).toMatchObject({
      images: true,
      approvals: true,
      interrupt: true,
      resume: true,
      queue: false,
      steer: false,
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
