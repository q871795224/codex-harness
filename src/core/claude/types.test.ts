import { describe, expect, it } from 'vitest'
import { claudeTurnPermissionOptions, parseClaudeModel, parseClaudeTokenUsage } from './types'

describe('Claude turn permission options', () => {
  it('enables the SDK safety acknowledgement for bypass mode', () => {
    expect(claudeTurnPermissionOptions({ permissionMode: 'bypassPermissions' })).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    })
  })

  it('does not enable the bypass acknowledgement for regular modes', () => {
    expect(claudeTurnPermissionOptions({ permissionMode: 'default' })).toEqual({
      permissionMode: 'default',
    })
  })

  it('normalizes SDK model capabilities for the composer', () => {
    expect(parseClaudeModel({
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      description: '平衡速度与质量',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    })).toMatchObject({
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-4-6',
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    })
  })

  it('normalizes Claude usage and context-window metadata', () => {
    expect(parseClaudeTokenUsage({
      total: { totalTokens: 120, inputTokens: 80, outputTokens: 40 },
      last: { totalTokens: 60, inputTokens: 45, outputTokens: 15 },
      modelContextWindow: 200_000,
    })).toEqual({
      total: expect.objectContaining({ totalTokens: 120, inputTokens: 80, outputTokens: 40 }),
      last: expect.objectContaining({ totalTokens: 60, inputTokens: 45, outputTokens: 15 }),
      modelContextWindow: 200_000,
    })
  })
})
