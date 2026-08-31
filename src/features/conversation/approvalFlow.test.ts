import { describe, expect, it } from 'vitest'
import { approvalResponse, isApprovalRequestMethod } from './approvalFlow'

describe('approval protocol mapping', () => {
  it('recognizes legacy, current, and user-input approval methods', () => {
    expect(isApprovalRequestMethod('execCommandApproval')).toBe(true)
    expect(isApprovalRequestMethod('applyPatchApproval')).toBe(true)
    expect(isApprovalRequestMethod('item/fileChange/requestApproval')).toBe(true)
    expect(isApprovalRequestMethod('item/tool/requestUserInput')).toBe(true)
    expect(isApprovalRequestMethod('item/completed')).toBe(false)
  })

  it('maps legacy accept and decline decisions to the legacy response shape', () => {
    expect(approvalResponse('execCommandApproval', 'accept')).toEqual({ decision: 'approved' })
    expect(approvalResponse('applyPatchApproval', 'decline')).toEqual({
      decision: { denied: { rejection: 'Denied in Codex Harness' } },
    })
  })

  it('passes current approval decisions through unchanged', () => {
    const decision = { acceptWithExecpolicyAmendment: { execpolicyAmendment: ['git', 'status'] } }
    expect(approvalResponse('item/commandExecution/requestApproval', decision)).toEqual({ decision })
  })

  it('cancels unsupported interactive input with an empty answer set', () => {
    expect(approvalResponse('item/tool/requestUserInput', 'cancel')).toEqual({ answers: {} })
  })
})
