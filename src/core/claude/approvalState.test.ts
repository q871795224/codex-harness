import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../domain/codex'
import { approvalRequestFromEvent, reconcileClaudeApprovalSnapshot } from './approvalState'

function request(id: string, threadId = 'claude:1'): ApprovalRequest {
  return {
    id,
    method: 'claude/tool/requestApproval',
    threadId,
    params: { toolName: 'Bash', input: { command: id }, command: id, reason: 'approval' },
  }
}

describe('Claude approval state', () => {
  it('maps live daemon approval events to UI requests', () => {
    expect(approvalRequestFromEvent({
      method: 'approval/requested',
      seq: 4,
      params: { requestId: 'approval-1', sessionId: 'claude:1', turnId: 'turn-1', toolName: 'Bash', input: { command: 'ls' } },
    })).toMatchObject({
      id: 'approval-1',
      threadId: 'claude:1',
      params: { command: 'ls', toolName: 'Bash' },
    })
  })

  it('drops historical approvals absent from the daemon snapshot', () => {
    const result = reconcileClaudeApprovalSnapshot(
      { 'claude:1': [request('old')] },
      [{ requestId: 'current', sessionId: 'claude:1', turnId: 'turn-2', toolName: 'Bash', input: { command: 'pwd' }, suggestions: [] }],
      10,
      { old: 4 },
      {},
      true,
    )

    expect(result.approvals['claude:1'].map((item) => item.id)).toEqual(['current'])
  })

  it('keeps a live approval created after the snapshot boundary', () => {
    const result = reconcileClaudeApprovalSnapshot(
      { 'claude:1': [request('future')] },
      [],
      10,
      { future: 11 },
      {},
      true,
    )

    expect(result.approvals['claude:1'].map((item) => item.id)).toEqual(['future'])
  })

  it('does not keep old-client approvals after the daemon instance changes', () => {
    const result = reconcileClaudeApprovalSnapshot(
      { 'claude:1': [request('old')] },
      [],
      10,
      { old: 11 },
      {},
      false,
    )

    expect(result.approvals).toEqual({})
  })

  it('keeps a resolution that raced with the snapshot', () => {
    const result = reconcileClaudeApprovalSnapshot(
      { 'claude:1': [request('resolved-later')] },
      [{ requestId: 'resolved-later', sessionId: 'claude:1', turnId: 'turn-1', toolName: 'Bash', input: { command: 'pwd' }, suggestions: [] }],
      10,
      { 'resolved-later': 4 },
      { 'resolved-later': 11 },
      true,
    )

    expect(result.approvals).toEqual({})
    expect(result.resolvedSeqById).toEqual({ 'resolved-later': 11 })
  })
})
