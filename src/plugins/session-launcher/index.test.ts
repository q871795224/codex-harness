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
    group: 'reference', model, effort, score: null, coverage: 50, price: null, minutes: null,
    bestScore: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor,
  })

  it('places Astra efforts between references and simple tasks with Radar metrics', () => {
    const rows = availableRows([
      row('gpt-5.6-sol', 'high', true),
      { ...row('gpt-6-astra', 'low'), score: 106.96, price: 2.029284, minutes: 9.35 },
      { ...row('gpt-6-astra', 'medium'), score: 110.46, price: 2.297875, minutes: 8.87 },
      { ...row('gpt-6-luna', 'max'), group: 'simple' },
    ], [model('gpt-5.6-sol', ['high']), model('gpt-6-luna', ['max']), model('gpt-6-astra', ['low', 'medium', 'high'])], base)
    expect(rows.map(({ group, model, effort }) => [group, model, effort])).toEqual([
      ['reference', 'gpt-5.6-sol', 'high'],
      ['agi', 'gpt-6-astra', 'low'],
      ['agi', 'gpt-6-astra', 'medium'],
      ['simple', 'gpt-6-luna', 'max'],
    ])
    expect(defaultRadarRow(rows)).toBe(rows[2])
    expect(rows[1]).toMatchObject({ score: 106.96, price: 2.029284, minutes: 9.35 })
    expect(rows[2]).toMatchObject({ score: 110.46, price: 2.297875, minutes: 8.87 })
    expect(selectedRadarRow(rows, { model: 'gpt-6-astra', effort: 'medium' })).toBe(rows[2])
  })

  it('retains measured GPT-6 Luna metrics and filters unsupported efforts', () => {
    const simple: PickerRow = {
      ...row('gpt-6-luna', 'max'), group: 'simple', score: 52.9, price: 0.12, minutes: 24, coverage: 39,
    }
    const models = [model('gpt-6-luna', ['max'])]
    expect(availableRows([simple], models, base)).toEqual([simple])
    expect(selectedRadarRow([simple], { model: 'gpt-6-luna', effort: 'max' })).toBe(simple)
    expect(availableRows([simple], [model('gpt-6-luna', ['high'])], base)[0]).toMatchObject({ group: 'fallback', score: null })
  })

  it('retains AGI choices when Radar is unavailable and respects supported efforts', () => {
    const rows = availableRows([], [model('gpt-5.6-sol', ['high']), model('gpt-6-astra', ['low'])], base)
    expect(rows.map(({ group, effort }) => [group, effort])).toEqual([['fallback', 'high'], ['agi', 'low']])
    expect(availableRows([], [model('gpt-5.6-sol', ['high'])], base)).toHaveLength(1)
  })

  it('uses configured model and effort for fallback even when old Sol is available', () => {
    const models = [model('gpt-5.6-sol', ['high', 'xhigh']), model('gpt-6-luna', ['low', 'high', 'max'])]
    const settings = { ...base, model: 'gpt-6-luna', effort: 'max' }
    for (const remote of [[], [row('unavailable', 'high')]]) {
      expect(availableRows(remote, models, settings)[0]).toMatchObject({ group: 'fallback', model: 'gpt-6-luna', effort: 'max' })
    }
    expect(availableRows([], models, { ...settings, effort: 'ultra' })[0].effort).toBe('low')
  })

  it('uses the App Server default when the configured model is unavailable', () => {
    const models = [model('gpt-5.6-sol', ['xhigh']), { ...model('gpt-6-luna', ['low']), isDefault: true }]
    expect(availableRows([], models, { ...base, model: 'unavailable' })[0]).toMatchObject({ model: 'gpt-6-luna', effort: 'low' })
    expect(availableRows([], [], base)).toEqual([])
  })

  it('moves existing Astra rows into AGI without duplicating or losing metrics', () => {
    const rows = availableRows([{ ...row('gpt-6-astra', 'low', true), score: 99, price: 1.23, minutes: 4.5 }], [model('gpt-6-astra', ['low', 'medium'])], base)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ group: 'agi', effort: 'low', score: 99, price: 1.23, minutes: 4.5, defaultCursor: true })
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

  it('does not default to an Astra score based on too few tasks', () => {
    const measured = { ...row('gpt-6.1-sol', 'high', true), score: 104.6 }
    const sparse = { ...row('gpt-6-astra', 'medium'), group: 'agi' as const, score: 150, coverage: 1 }
    expect(defaultRadarRow([sparse, measured])).toBe(measured)
  })

  it('allows Sol high references to become the default alongside fixed Astra choices', () => {
    const sol = { ...row('gpt-6.1-sol', 'high', true), score: 104.6, price: 0.48 }
    const rows = availableRows([
      sol,
      { ...row('gpt-6-astra', 'low'), group: 'agi', score: 99.9, price: 2.46 },
      { ...row('gpt-6-astra', 'medium'), group: 'agi', score: 90.1, price: 2.29 },
    ], [model('gpt-6.1-sol', ['medium', 'high']), model('gpt-6-astra', ['low', 'medium'])], base)
    expect(defaultRadarRow(rows)).toEqual(sol)
  })

  it('compares only reference and AGI, choosing a cheaper runner-up within two score points', () => {
    const highest = { ...row('astra', 'medium'), group: 'agi' as const, score: 110, price: 3 }
    const second = { ...row('sol', 'high'), score: 108, price: 1 }
    const excluded = { ...row('hard', 'high'), group: 'hard' as const, score: 150, price: 0.1 }
    expect(defaultRadarRow([excluded, highest, second])).toBe(second)
    expect(defaultRadarRow([highest, { ...second, score: 107.99 }])).toBe(highest)
    expect(defaultRadarRow([highest, { ...second, price: 3 }])).toBe(highest)
    expect(defaultRadarRow([highest, { ...second, price: null }])).toBe(highest)
    expect(defaultRadarRow([highest, second, { ...second, model: 'third', score: 107, price: 0.01 }])).toBe(second)
    expect(defaultRadarRow([{ ...highest, score: null }, second])).toBe(second)
  })
})
