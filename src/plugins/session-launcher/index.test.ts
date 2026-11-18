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
  const row = (model: string, effort: string, score = 100, price: number | null = 1): PickerRow => ({
    group: 'reference', model, effort, score, coverage: 4, requiredTasks: 4, price, minutes: 1,
    bestScore: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor: false,
  })

  it('shows exactly seven choices in three groups, independent of website rank or missing models', () => {
    const rows = availableRows([
      row('gpt-5.6-sol', 'high', 150), row('gpt-6.2-astra', 'xhigh', 149),
      row('gpt-6.2-sol', 'medium', 131), row('gpt-6.1-sol', 'high', 120),
    ], [model('gpt-6.1-sol', ['medium', 'high'])])
    expect(rows.map(({ group, model, effort }) => [group, model, effort])).toEqual([
      ['reference', 'gpt-6.1-sol', 'medium'],
      ['reference', 'gpt-6.1-sol', 'high'],
      ['reference', 'gpt-6.2-sol', 'medium'],
      ['reference', 'gpt-6.1-terra', 'max'],
      ['agi', 'gpt-6.2-astra', 'medium'],
      ['agi', 'gpt-6-astra', 'medium'],
      ['simple', 'gpt-6-luna', 'max'],
    ])
    expect(rows[1]).toMatchObject({ score: 120, available: true })
    expect(rows[2]).toMatchObject({ score: 131, available: false })
    expect(defaultRadarRow(rows)).toBe(rows[1])
    expect(availableRows(null, [])).toEqual([])
  })

  it('retains measured metrics when a model is unavailable, and enables its exact effort when discovered', () => {
    const measured = row('gpt-6.2-sol', 'medium', 131, 0.779)
    const rows = availableRows([measured], [model('gpt-6.2-sol', ['high'])])
    expect(rows[2]).toMatchObject({ score: 131, price: 0.779, available: false })
    expect(defaultRadarRow(rows)).toBeNull()
    const updated = availableRows([measured], [model('gpt-6.2-sol', ['medium', 'high'])])
    expect(updated).toHaveLength(7)
    expect(updated[2].available).toBe(true)
    expect(defaultRadarRow(updated)).toBe(updated[2])
  })

  it('keeps seven manual choices during a Radar outage without changing the configured default', () => {
    const rows = availableRows([], [model('gpt-6-astra', ['medium']), model('gpt-6.1-sol', ['high'])])
    expect(rows).toHaveLength(7)
    expect(rows[1]).toMatchObject({ available: true, score: null, price: null, minutes: null })
    expect(rows[5]).toMatchObject({ available: true, effort: 'medium' })
    expect(defaultRadarRow(rows)).toBeNull()
    expect(selectedRadarRow(rows, { model: 'gpt-6-astra', effort: 'medium' })).toBe(rows[5])
    expect(selectedRadarRow(rows, { model: 'gpt-6-astra', effort: 'low' })).toBeNull()
  })

  it('compares only the three Sol choices, excluding Terra, both Astras, Luna and unlisted efforts', () => {
    const sol = row('gpt-6.1-sol', 'high', 120)
    const excluded = [
      row('gpt-6.1-terra', 'max', 150), row('gpt-6.2-astra', 'medium', 149),
      row('gpt-6-astra', 'medium', 148), row('gpt-6-luna', 'max', 147),
      row('gpt-6.1-sol', 'max', 146), row('gpt-5.6-sol', 'high', 145),
    ].map((row) => ({ ...row, defaultCursor: true }))
    expect(defaultRadarRow([...excluded, sol])).toBe(sol)
    expect(defaultRadarRow(excluded)).toBeNull()
    expect(defaultRadarRow([{ ...sol, available: false }, ...excluded])).toBeNull()
  })

  it('uses measured coverage and does not auto-select a sparse or unscored result', () => {
    const high = row('gpt-6.1-sol', 'high', 120)
    const sparse = { ...row('gpt-6.2-sol', 'medium', 150), coverage: 2 }
    expect(defaultRadarRow([sparse, high])).toBe(high)
    expect(defaultRadarRow([{ ...high, score: null }])).toBeNull()
    expect(defaultRadarRow([{ ...high, score: NaN }])).toBeNull()
  })

  it('chooses a cheaper runner-up only within two score points', () => {
    const highest = row('gpt-6.2-sol', 'medium', 131, 1)
    const second = row('gpt-6.1-sol', 'high', 129, 0.5)
    expect(defaultRadarRow([highest, second])).toBe(second)
    expect(defaultRadarRow([highest, { ...second, score: 128.99 }])).toBe(highest)
    expect(defaultRadarRow([highest, { ...second, price: 1 }])).toBe(highest)
    expect(defaultRadarRow([highest, { ...second, price: null }])).toBe(highest)
    expect(defaultRadarRow([{ ...highest, score: 129 }, second])).toBe(second)
  })

  it('recomputes stars from the displayed comparisons instead of hidden website winners', () => {
    const rows = availableRows([
      row('gpt-6.1-sol', 'high', 120, 0.5),
      row('gpt-6.1-terra', 'max', 140, 2),
      row('gpt-6.2-astra', 'xhigh', 150, 0.1),
      row('gpt-6-luna', 'max', 90, 0.01),
    ], [])
    expect(rows[1]).toMatchObject({ bestPrice: true, bestScore: false })
    expect(rows[3]).toMatchObject({ bestScore: true, bestPrice: false })
    expect(rows[6]).toMatchObject({ bestScore: false, bestPrice: false })
  })
})
