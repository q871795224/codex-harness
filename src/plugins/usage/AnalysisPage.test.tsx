// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalysisPage, dateBounds } from './AnalysisPage'
import type { CodexAnalyticsService, CodexAnalyticsSnapshot } from '../../core/codex-analytics/types'
const tokens = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 }
export const snapshot: CodexAnalyticsSnapshot = {
  capturedSince: 1, generatedAt: 2, counter: { mode: 'local', apiKeyConfigured: false, localEstimator: 'test' }, droppedEvents: 0, writeErrors: 0, officialFallbacks: 0,
  summary: { sessions: 1, turns: 1, actual: tokens, inputContentTokens: 2, inputContentIncomplete: false, incompleteTurns: 0, reroutedTurns: 0 },
  daily: [{ date: '2026-09-07', turns: 1, actual: tokens }], models: [{ model: 'fixture-model', sessions: 1, turns: 1, actual: tokens, reroutedTurns: 0 }], availableModels: ['fixture-model'],
  hotspots: [{ kind: 'skill', name: 'demo-skill', calls: 3, selected: 1, reads: 2, sessions: 1, failed: 0, tokens: 20, argumentTokens: 0, resultTokens: 0, missingCounts: 0 }, { kind: 'agents', name: 'fixture / AGENTS.md', calls: 1, selected: 0, reads: 1, sessions: 1, failed: 0, tokens: 0, argumentTokens: 0, resultTokens: 0, missingCounts: 1 }],
  sessions: [{ threadId: 'thread-fixture', project: 'fixture', startedAt: 1, turns: 1, actual: tokens, incomplete: false, rerouted: false }],
  turns: [{ turnId: 'turn-fixture', startedAt: 1, model: 'fixture-model', source: 'conversation', status: 'completed', actual: tokens, incomplete: false, rerouted: false, content: [] }], totalSessions: 1, totalTurns: 1,
}
const usage = { cachedSnapshot: vi.fn(async () => null), refreshSnapshot: vi.fn(async () => ({ fetchedAt: 0, since: '', until: '', providers: [] })) }
const conversations = { openThread: vi.fn(async () => undefined), onTurnCompleted: () => () => undefined }
function mount(service: CodexAnalyticsService = { configure: vi.fn(), snapshot: vi.fn(async () => snapshot) }) { render(<AnalysisPage service={service} usage={usage} conversations={conversations} threads={[]} />); return service }
afterEach(cleanup)
describe('analysis page', () => {
  it('shows core totals without counting cache twice or displaying instructional banners', async () => {
    mount(); await screen.findByText('用户输入内容 ≈')
    const metrics = document.querySelector('.analysis-metrics')!
    expect(metrics.textContent).toContain('实际 Token120')
    expect(document.querySelector('.analysis-warning')).toBeNull()
    expect(screen.queryByText('点击日期查看当天会话')).toBeNull()
    expect(usage.refreshSnapshot).not.toHaveBeenCalled()
  })
  it('drills into a model using a backend filter', async () => {
    const service = mount(); await screen.findByText('用户输入内容 ≈')
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'fixture-model' }))
    await waitFor(() => expect(service.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'fixture-model', offset: 0 })))
  })
  it('keeps skill selections distinct from reads and filters by the selected skill', async () => {
    const service = mount(); await screen.findByText('用户输入内容 ≈')
    fireEvent.click(screen.getByRole('button', { name: '热点' }))
    expect(screen.getByRole('columnheader', { name: '显式选择' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '观测读取' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'demo-skill' }))
    await waitFor(() => expect(service.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'skill', name: 'demo-skill' })))
    fireEvent.click(screen.getByRole('button', { name: '清除热点筛选' }))
    await waitFor(() => expect(service.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ kind: undefined, name: undefined })))
  })
  it('shows unobserved automatic AGENTS loading as unavailable', async () => {
    mount(); await screen.findByText('用户输入内容 ≈')
    fireEvent.click(screen.getByRole('button', { name: '热点' }))
    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }))
    expect(screen.getByText('未采集')).toBeTruthy()
    expect(within(screen.getByRole('table')).getByText('—')).toBeTruthy()
  })
  it('does not show stale results after changing filters', async () => {
    let resolve: (s: CodexAnalyticsSnapshot) => void = () => undefined
    const service = { configure: vi.fn(), snapshot: vi.fn().mockResolvedValueOnce(snapshot).mockImplementation(() => new Promise<CodexAnalyticsSnapshot>((r) => { resolve = r })) }
    mount(service); await screen.findByText('用户输入内容 ≈')
    fireEvent.change(screen.getByRole('combobox', { name: '模型筛选' }), { target: { value: 'fixture-model' } })
    expect(screen.queryByText('用户输入内容 ≈')).toBeNull()
    await act(async () => resolve(snapshot))
    expect(screen.getByText('用户输入内容 ≈')).toBeTruthy()
  })
  it('keeps history available when analytics fails', async () => {
    mount({ configure: vi.fn(), snapshot: vi.fn().mockRejectedValue(new Error('collector unavailable')) })
    await screen.findByRole('alert')
    expect(screen.getByText('账号额度与历史用量')).toBeTruthy()
  })
  it('validates date bounds and uses the next local midnight for inclusive dates', () => {
    expect(dateBounds('2026-09-07', '2026-09-06')).toBeNull()
    expect(dateBounds('', '')).toBeNull()
    expect(dateBounds('2026-09-07', '2026-09-07')).toEqual({ since: +new Date('2026-09-07T00:00:00'), until: +new Date('2026-09-08T00:00:00') })
  })
})
