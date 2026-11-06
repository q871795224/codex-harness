// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { ROUTER_SETTINGS_KEY } from '../../core/workspace-router/settings'
import { refreshRouterSummaries } from '../../core/workspace-router/summaries'
import { RouterSettings, routerNextCheck } from './RouterSettings'
vi.mock('../../core/workspace-router/summaries', () => ({ refreshRouterSummaries: vi.fn().mockResolvedValue([]) }))
vi.mock('../../core/runtime/bridge', () => ({ runtime: { routerSummaries: vi.fn().mockResolvedValue([]), getAppState: vi.fn(), setAppState: vi.fn() } }))
beforeEach(() => { vi.resetAllMocks(); vi.mocked(refreshRouterSummaries).mockResolvedValue([]); vi.mocked(runtime.routerSummaries).mockResolvedValue([]); vi.mocked(runtime.getAppState).mockResolvedValue(null); vi.mocked(runtime.setAppState).mockResolvedValue(undefined) })
afterEach(cleanup)
it('keeps the configured default model available and saves workspace descriptions without losing unrelated entries', async () => {
  vi.mocked(runtime.getAppState).mockResolvedValue(JSON.stringify({ descriptions: { '/hidden': 'keep me' } }))
  render(<RouterSettings models={[]} workspaces={[{ root: '/a', checkoutRoot: '/a', name: 'A', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }]} />)
  await waitFor(() => expect((screen.getByLabelText('Router 模型') as HTMLSelectElement).disabled).toBe(false))
  expect((screen.getByLabelText('Router 模型') as HTMLSelectElement).value).toBe('gpt-6.1-terra')
  expect((screen.getByLabelText('Router 推理强度') as HTMLSelectElement).value).toBe('medium')
  fireEvent.change(screen.getByLabelText('A 的路由用途'), { target: { value: 'Server implementation' } })
  fireEvent.change(screen.getByLabelText('Router 推理强度'), { target: { value: 'low' } })
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已保存，下次路由生效'))
  expect(runtime.setAppState).toHaveBeenCalledWith(ROUTER_SETTINGS_KEY, expect.any(String))
  expect(JSON.parse(vi.mocked(runtime.setAppState).mock.calls.at(-1)![1])).toEqual({ tokenBudget: 8192, feedbackCount: 3, feedbackRule: 'relevant', model: 'gpt-6.1-terra', effort: 'low', descriptions: { '/hidden': 'keep me', '/a': 'Server implementation' } })
})
it('reports a settings read failure', async () => {
  vi.mocked(runtime.getAppState).mockRejectedValue(new Error('read failed'))
  render(<RouterSettings models={[]} workspaces={[]} />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('read failed'))
  expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(true)
})
it('shows cached text, next-check countdown and refreshes the selected workspace immediately', async () => {
  const now = Date.now(), day = 24 * 60 * 60_000
  const workspace = { root: '/a', checkoutRoot: '/a', name: 'A', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }
  vi.mocked(runtime.routerSummaries).mockResolvedValue([{ root: '/a', checkoutRoot: '/a', description: '管理DNS接口', checkedAt: now, generatedAt: now - 1000, nextCheckAt: now + day, error: false }])
  render(<RouterSettings models={[]} workspaces={[workspace]} initialSection="workspaces" />)
  await screen.findByText('管理DNS接口')
  expect(screen.getByText('24 小时后检查')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '立即更新' }))
  await waitFor(() => expect(refreshRouterSummaries).toHaveBeenCalledWith([workspace], expect.any(Function), true))
  await screen.findByText('检查完成，最新状态已显示。')
  fireEvent.click(screen.getByRole('tab', { name: '设置' }))
  expect((screen.getByLabelText('Router 模型') as HTMLSelectElement).value).toBe('gpt-6.1-terra')
})
it('retains old text on an update failure and re-enables manual retry', async () => {
  vi.mocked(refreshRouterSummaries).mockResolvedValue([{ root: '/a', failed: true }])
  vi.mocked(runtime.routerSummaries).mockResolvedValue([{ root: '/a', checkoutRoot: '/a', description: '旧介绍', checkedAt: 1, generatedAt: 1, error: true }])
  render(<RouterSettings models={[]} workspaces={[{ root: '/a', checkoutRoot: '/a', name: 'A', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }]} initialSection="workspaces" />)
  await screen.findByText('旧介绍')
  fireEvent.click(screen.getByRole('button', { name: '立即更新' }))
  await screen.findByText('1 个工作区更新失败，已保留原有介绍，可重试。')
  expect(screen.getByText('旧介绍')).toBeTruthy()
  expect((screen.getByRole('button', { name: '立即更新' }) as HTMLButtonElement).disabled).toBe(false)
})
it('formats due, missing and running schedule states', () => {
  expect(routerNextCheck(undefined, 0)).toBe('等待首次检查')
  const base = { root: '/a', checkoutRoot: '/a', description: '', checkedAt: 1, generatedAt: null, error: false }
  expect(routerNextCheck({ ...base, nextCheckAt: 10 }, 11)).toBe('已到检查时间')
  expect(routerNextCheck({ ...base, updating: true }, 10)).toBe('正在更新介绍')
  expect(routerNextCheck({ ...base, nextCheckAt: 60_001 }, 1)).toBe('1 分钟后检查')
})
it('supports keyboard switching between materials and judgement settings', async () => {
  render(<RouterSettings models={[]} workspaces={[]} initialSection="workspaces" />)
  const materials = screen.getByRole('tab', { name: '工作区' })
  fireEvent.keyDown(materials, { key: 'ArrowRight' })
  const prompt = screen.getByRole('tab', { name: '最终 Prompt' })
  expect(prompt.getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(prompt, { key: 'End' })
  const settings = screen.getByRole('tab', { name: '设置' })
  expect(settings.getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(settings)
  fireEvent.keyDown(settings, { key: 'Home' })
  expect(materials.getAttribute('aria-selected')).toBe('true')
})
it('saves correction count and ordering while keeping unimplemented backends unavailable', async () => {
  render(<RouterSettings models={[]} workspaces={[]} />)
  await waitFor(() => expect((screen.getByLabelText('Router 模型') as HTMLSelectElement).disabled).toBe(false))
  const radios = screen.getAllByRole('radio') as HTMLInputElement[]
  expect(radios[0].checked).toBe(true)
  expect(radios[1].closest('fieldset')?.disabled).toBe(true)
  expect(radios[2].closest('fieldset')?.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('纠错引用上限'), { target: { value: '5' } })
  fireEvent.change(screen.getByLabelText('纠错选取规则'), { target: { value: 'recent' } })
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  await screen.findByText('已保存，下次路由生效')
  expect(JSON.parse(vi.mocked(runtime.setAppState).mock.calls.at(-1)![1])).toMatchObject({ feedbackCount: 5, feedbackRule: 'recent' })
})
