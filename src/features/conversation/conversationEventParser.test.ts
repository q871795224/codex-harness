import { describe, expect, it } from 'vitest'
import {
  eventPermissionProfile,
  eventSandboxPolicy,
  eventThreadId,
  eventThreadItem,
  eventThreadSettings,
  parseEventTokenUsage,
  parseEventTurnPlan,
} from './conversationEventParser'

describe('conversation event parsing', () => {
  it('accepts threadId and the legacy conversationId fallback', () => {
    expect(eventThreadId({ threadId: 'thread-1', conversationId: 'legacy' })).toBe('thread-1')
    expect(eventThreadId({ threadId: 42, conversationId: 'legacy' })).toBe('legacy')
    expect(eventThreadId({ conversationId: false })).toBeNull()
  })

  it('requires an item object with a string type', () => {
    expect(eventThreadItem({ id: 'item-1', type: 'agentMessage' })).toEqual({ id: 'item-1', type: 'agentMessage' })
    expect(eventThreadItem({ type: 42 })).toBeNull()
    expect(eventThreadItem(null)).toBeNull()
  })

  it('keeps only recognized thread settings', () => {
    expect(eventThreadSettings({
      model: 'gpt-test',
      effort: 'high',
      serviceTier: null,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })).toEqual({
      model: 'gpt-test',
      effort: 'high',
      serviceTier: null,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxMode: 'read-only',
    })
    expect(eventThreadSettings({ approvalPolicy: 'invalid', sandboxPolicy: { type: 'readOnly' } })).toEqual({})
  })

  it('validates sandbox and permission-profile payloads', () => {
    expect(eventSandboxPolicy({
      type: 'workspaceWrite', writableRoots: ['/repo'], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    })).toMatchObject({ type: 'workspaceWrite', writableRoots: ['/repo'] })
    expect(eventSandboxPolicy({ type: 'workspaceWrite', writableRoots: [42] })).toBeUndefined()
    expect(eventPermissionProfile({ id: 'profile-1', extends: 'base' })).toEqual({ id: 'profile-1', extends: 'base' })
    expect(eventPermissionProfile({ id: 42 })).toBeNull()
  })

  it('normalizes valid usage counters and rejects incomplete totals', () => {
    const usage = parseEventTokenUsage({
      total: { totalTokens: 10, inputTokens: -2, outputTokens: 4 },
      last: { totalTokens: 5, cachedInputTokens: 2 },
      modelContextWindow: 100,
    })
    expect(usage).toMatchObject({
      total: { totalTokens: 10, inputTokens: 0, outputTokens: 4 },
      last: { totalTokens: 5, cachedInputTokens: 2 },
      modelContextWindow: 100,
    })
    expect(parseEventTokenUsage({ total: { totalTokens: Number.NaN }, last: { totalTokens: 1 } })).toBeNull()
    expect(parseEventTokenUsage({ total: {}, last: {} })).toBeNull()
  })

  it('filters malformed plan entries while preserving valid steps', () => {
    expect(parseEventTurnPlan([
      { step: '检查', status: 'inProgress' },
      { step: '完成', status: 'completed' },
      { step: 42, status: 'pending' },
      { step: '未知', status: 'unknown' },
    ])).toEqual([
      { step: '检查', status: 'inProgress' },
      { step: '完成', status: 'completed' },
    ])
    expect(parseEventTurnPlan({})).toBeNull()
  })
})
