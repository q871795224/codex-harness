import { describe, expect, it } from 'vitest'
import type { ThreadCodexSettings } from '../../core/domain/codex'
import { isYoloMode, yoloModeSettings } from './yoloMode'

const settings: ThreadCodexSettings = {
  model: 'gpt-5.6-sol',
  effort: 'medium',
  serviceTier: null,
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  sandboxMode: 'danger-full-access',
}

describe('YOLO mode', () => {
  it('requires both approval-free and full-access settings', () => {
    expect(isYoloMode(settings)).toBe(true)
    expect(isYoloMode({ ...settings, approvalPolicy: 'on-request' })).toBe(false)
    expect(isYoloMode({ ...settings, sandboxMode: 'workspace-write' })).toBe(false)
  })

  it('switches between YOLO and the safe standard settings', () => {
    expect(yoloModeSettings(true)).toEqual({
      approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access',
    })
    expect(yoloModeSettings(false)).toEqual({
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxMode: 'workspace-write',
    })
  })
})
