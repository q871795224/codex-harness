import { describe, expect, it } from 'vitest'
import type { ThreadCodexSettings } from '../../core/domain/codex'
import { defaultRadarRow, launchMode, modePatch, selectedRadarRow, type PickerRow } from './index'

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

describe('session launcher model selection', () => {
  const row = (model: string, effort: string, defaultCursor = false): PickerRow => ({
    group: 'reference', model, effort, iq: null, price: null, minutes: null,
    bestIq: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor,
  })

  it('uses the exact session settings when a Radar row matches', () => {
    const rows = [row('gpt-5.6-sol', 'high'), row('gpt-5.6-terra', 'max', true)]
    expect(selectedRadarRow(rows, { model: 'gpt-5.6-sol', effort: 'high' })?.model).toBe('gpt-5.6-sol')
  })

  it('falls back to the Radar default cursor when the session has no matching row', () => {
    const rows = [row('gpt-5.6-sol', 'high'), row('gpt-5.6-terra', 'max', true)]
    expect(selectedRadarRow(rows, { model: 'custom', effort: 'high' })).toBeNull()
    expect(defaultRadarRow(rows)?.model).toBe('gpt-5.6-terra')
  })
})
