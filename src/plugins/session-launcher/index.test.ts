import { describe, expect, it } from 'vitest'
import type { ThreadCodexSettings } from '../../core/domain/codex'
import { launchMode, modePatch } from './index'

const base: ThreadCodexSettings = {
  model: 'gpt-5.6-sol',
  effort: 'high',
  serviceTier: null,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandboxMode: 'workspace-write',
}

describe('session launcher modes', () => {
  it('maps YOLO to approval-free full access', () => {
    const settings = { ...base, ...modePatch('yolo') }
    expect(settings).toMatchObject({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxMode: 'danger-full-access',
    })
    expect(launchMode(settings)).toBe('yolo')
  })

  it('keeps automatic and manual review distinct', () => {
    expect(launchMode({ ...base, ...modePatch('auto-review') })).toBe('auto-review')
    expect(launchMode({ ...base, ...modePatch('manual') })).toBe('manual')
  })
})
