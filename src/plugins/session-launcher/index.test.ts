import { describe, expect, it } from 'vitest'
import type { CodexModel, ThreadCodexSettings } from '../../core/domain/codex'
import { availableRows, defaultRadarRow, launchMode, modePatch, selectedRadarRow, type PickerRow } from './index'

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
  const model = (id: string, efforts: string[]): CodexModel => ({
    id, model: id, displayName: id, description: '', hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
    defaultReasoningEffort: efforts[0], inputModalities: ['text'], isDefault: false,
  })
  const row = (model: string, effort: string, defaultCursor = false): PickerRow => ({
    group: 'reference', model, effort, iq: null, price: null, minutes: null,
    bestIq: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor,
  })

  it('places fixed Astra efforts between references and simple tasks', () => {
    const rows = availableRows([
      row('gpt-5.6-sol', 'high', true),
      { ...row('gpt-5.6-luna', 'max'), group: 'simple' },
    ], [model('gpt-5.6-sol', ['high']), model('gpt-5.6-luna', ['max']), model('gpt-6-astra', ['low', 'medium', 'high'])], base)
    expect(rows.map(({ group, model, effort }) => [group, model, effort])).toEqual([
      ['reference', 'gpt-5.6-sol', 'high'],
      ['agi', 'gpt-6-astra', 'low'],
      ['agi', 'gpt-6-astra', 'medium'],
      ['simple', 'gpt-5.6-luna', 'max'],
    ])
    expect(defaultRadarRow(rows)?.model).toBe('gpt-5.6-sol')
    expect(rows[1].iq).toBeNull()
    expect(selectedRadarRow(rows, { model: 'gpt-6-astra', effort: 'medium' })).toBe(rows[2])
  })

  it('retains AGI choices when Radar is unavailable and respects supported efforts', () => {
    const rows = availableRows([], [model('gpt-5.6-sol', ['high']), model('gpt-6-astra', ['low'])], base)
    expect(rows.map(({ group, effort }) => [group, effort])).toEqual([['fallback', 'high'], ['agi', 'low']])
    expect(availableRows([], [model('gpt-5.6-sol', ['high'])], base)).toHaveLength(1)
  })

  it('moves existing Astra rows into AGI without duplicating or losing metrics', () => {
    const rows = availableRows([{ ...row('gpt-6-astra', 'low', true), iq: 99 }], [model('gpt-6-astra', ['low', 'medium'])], base)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ group: 'agi', effort: 'low', iq: 99, defaultCursor: true })
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
