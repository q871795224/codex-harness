// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalysisPage, dateBounds } from './AnalysisPage'
import { cacheRate, calendarDays, formatTokens } from './format'
import type { CodexAnalyticsService, CodexAnalyticsSnapshot } from '../../core/codex-analytics/types'
const tokens = { totalTokens: 1200000, inputTokens: 1000000, cachedInputTokens: 800000, cacheWriteInputTokens: 0, outputTokens: 200000, reasoningOutputTokens: 5 }
const workspaces = [{ workspace: '/repo/fixture', sessions: 1, turns: 1, actual: tokens }]
const resourceWorkspaces = [{ workspace: '/repo/fixture', calls: 3, selected: 1, reads: 2, sessions: 1 }]
export const snapshot: CodexAnalyticsSnapshot = {
  capturedSince: 1, generatedAt: 2, counter: { mode: 'local', apiKeyConfigured: false, localEstimator: 'test' }, droppedEvents: 0, writeErrors: 0, officialFallbacks: 0,
  summary: { sessions: 1, turns: 1, actual: tokens, inputContentTokens: 2, inputContentIncomplete: false, incompleteTurns: 0, reroutedTurns: 0 },
  daily: [{ date: '2026-09-07', turns: 1, actual: tokens, models: [{ model: 'fixture-model', actual: tokens }] }], models: [{ model: 'fixture-model', sessions: 1, turns: 1, actual: tokens, reroutedTurns: 0, inputContentTokens: 2, inputContentIncomplete: false }], availableModels: ['fixture-model'], workspaces,
  hotspots: [{ kind: 'skill', name: 'demo-skill', calls: 3, selected: 1, reads: 2, sessions: 1, failed: 0, tokens: 20, argumentTokens: 0, resultTokens: 0, missingCounts: 0, workspaces: resourceWorkspaces }, { kind: 'agents', name: 'fixture / AGENTS.md', calls: 1, selected: 0, reads: 1, sessions: 1, failed: 0, tokens: 0, argumentTokens: 0, resultTokens: 0, missingCounts: 1, workspaces: resourceWorkspaces }],
  sessions: [{ threadId: 'thread-fixture', workspace: '/repo/fixture', title: '已归档的真实名称', startedAt: 1, turns: 1, actual: tokens, incomplete: false, rerouted: false }],
  turns: [{ turnId: 'turn-fixture', startedAt: 1, model: 'fixture-model', source: 'conversation', status: 'completed', actual: tokens, incomplete: false, rerouted: false, content: [] }], totalSessions: 1, totalTurns: 1,
}
const usage = { cachedSnapshot: vi.fn(async () => null), refreshSnapshot: vi.fn(async () => ({ fetchedAt: 0, since: '', until: '', providers: [] })) }
const conversations = { openThread: vi.fn(async () => undefined), onTurnCompleted: () => () => undefined }
function mount(overrides: Partial<CodexAnalyticsService> = {}) {
  const service: CodexAnalyticsService = { configure: vi.fn(), costs: vi.fn(async () => ({ models: [], message: '暂不可用' })), snapshot: vi.fn(async () => snapshot), refreshMetadata: vi.fn(async () => 0), threadUsage: vi.fn(async () => null), ...overrides }
  render(<AnalysisPage service={service} usage={usage} conversations={conversations} threads={[]} />)
  return service
}
afterEach(() => { cleanup(); vi.clearAllMocks() })
describe('analysis page', () => {
  it('keeps source cards above all seven views and formats actual totals and cache rate', async () => {
    mount(); await screen.findByText('缓存命中率')
    expect(document.querySelector('.analysis-metrics')!.textContent).toContain('总 Token1.2M')
    expect(document.querySelector('.analysis-metrics')!.textContent).toContain('80.0%')
    expect(within(screen.getByRole('navigation')).getAllByRole('button')).toHaveLength(7)
    expect(within(screen.getByRole('region', { name: '账号用量' })).getAllByRole('heading')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    expect(screen.getByRole('region', { name: '账号用量' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '用户输入 Token ≈' })).toBeTruthy()
  })
  it('drills into a model and clears the filter when switching tabs', async () => {
    const service = mount(); await screen.findByText('缓存命中率')
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'fixture-model' }))
    await waitFor(() => expect(service.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'fixture-model', offset: 0 })))
    fireEvent.click(screen.getByRole('button', { name: '工作区' }))
    await waitFor(() => expect(service.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ model: undefined })))
  })
  it('keeps skill selection and reading separate and drills down by full workspace', async () => {
    const service = mount(); await screen.findByText('缓存命中率')
    fireEvent.click(screen.getByRole('button', { name: 'Skill' }))
    expect(screen.getByText('1 次显式选择 · 2 次观测读取')).toBeTruthy()
    fireEvent.click(screen.getByText('demo-skill'))
    expect(screen.getByRole('columnheader', { name: '显式选择' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'fixture' }))
    await waitFor(() => expect(service.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'skill', name: 'demo-skill', workspace: '/repo/fixture' })))
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    await waitFor(() => expect(service.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ kind: undefined, workspace: undefined })))
  })
  it('labels automatic AGENTS loading as unobserved', async () => {
    mount(); await screen.findByText('缓存命中率')
    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }))
    expect(screen.getByText('仅统计观测到的显式读取，自动加载未采集。')).toBeTruthy()
  })
  it('resolves archived names independently of the sidebar', async () => {
    mount(); await screen.findByText('已归档的真实名称')
    expect(screen.queryByText('会话 thread-f')).toBeNull()
  })
  it('does not show stale analysis after changing dates; sources use the same dates', async () => {
    const request = vi.fn(async () => snapshot)
    const service = mount({ snapshot: request }); await screen.findByText('缓存命中率')
    await waitFor(() => expect(service.refreshMetadata).toHaveBeenCalled())
    let resolve!: (s: CodexAnalyticsSnapshot) => void
    request.mockImplementation(() => new Promise((r) => { resolve = r }))
    fireEvent.change(screen.getByRole('combobox', { name: '时间范围' }), { target: { value: '7d' } })
    expect(document.querySelector('.analysis-metrics')).toBeNull()
    await act(async () => resolve(snapshot))
    const [since, until] = usage.refreshSnapshot.mock.calls.at(-1) as unknown as [string, string]
    expect(service.snapshot).toHaveBeenLastCalledWith(expect.objectContaining(dateBounds(since, until)!))
  })
  it('keeps account sources available when analytics fails and refreshes both', async () => {
    const service = mount({ snapshot: vi.fn().mockRejectedValue(new Error('collector unavailable')) })
    await screen.findByRole('alert')
    expect(screen.getByRole('region', { name: '账号用量' })).toBeTruthy()
    const count = usage.refreshSnapshot.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '刷新分析' }))
    await waitFor(() => expect(usage.refreshSnapshot.mock.calls.length).toBeGreaterThan(count))
    expect(service.snapshot).toHaveBeenCalled()
  })
  it('validates inclusive dates and fills zero-activity days', () => {
    expect(dateBounds('2026-09-07', '2026-09-06')).toBeNull()
    expect(dateBounds('', '')).toBeNull()
    expect(dateBounds('2026-09-07', '2026-09-07')).toEqual({ since: +new Date('2026-09-07T00:00:00'), until: +new Date('2026-09-08T00:00:00') })
    expect(calendarDays('2026-08-30', '2026-09-02')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'])
    expect([999, 1234, 1200000, 1230000000].map(formatTokens)).toEqual(['999', '1.23K', '1.2M', '1.23B'])
    expect(cacheRate(0, 0)).toBe('—')
  })
})
it('renders official model credits only when native reconciliation succeeds', async () => {
  const costs = vi.fn(async () => ({ models: [{ model: 'fixture-model', credits: 0.125 }], message: null }))
  mount({ costs }); await screen.findByText('缓存命中率')
  fireEvent.click(screen.getByRole('button', { name: '模型' }))
  await screen.findByRole('img', { name: /模型 credits 占比/ })
  expect(screen.getByText('0.125')).toBeTruthy()
  expect(costs).toHaveBeenCalledWith(expect.objectContaining({ model: undefined, workspace: undefined }))
})
