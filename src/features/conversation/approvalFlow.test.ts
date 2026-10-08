import { describe, expect, it } from 'vitest'
import { approvalResponse, isApprovalRequestMethod, isServerRequestMethod, serverRequestResponse } from './approvalFlow'

describe('approval protocol mapping', () => {
  it('recognizes legacy and current approval methods without misclassifying user input', () => {
    expect(isApprovalRequestMethod('execCommandApproval')).toBe(true)
    expect(isApprovalRequestMethod('applyPatchApproval')).toBe(true)
    expect(isApprovalRequestMethod('item/fileChange/requestApproval')).toBe(true)
    expect(isApprovalRequestMethod('item/tool/requestUserInput')).toBe(false)
    expect(isApprovalRequestMethod('item/completed')).toBe(false)
  })

  it('recognizes user input as a server request that needs a client response', () => {
    expect(isServerRequestMethod('item/tool/requestUserInput')).toBe(true)
    expect(isServerRequestMethod('item/commandExecution/requestApproval')).toBe(true)
    expect(isServerRequestMethod('item/completed')).toBe(false)
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

  it('passes structured user input answers through as the server request result', () => {
    const response = { answers: { approach: { answers: ['lightweight'] } } }
    expect(serverRequestResponse('item/tool/requestUserInput', response)).toEqual(response)
    expect(serverRequestResponse('item/tool/requestUserInput', 'invalid')).toEqual({ answers: {} })
  })
})
