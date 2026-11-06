// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { ROUTER_SETTINGS_KEY } from '../../core/workspace-router/settings'
import { RouterSettings } from './RouterSettings'
vi.mock('../../core/runtime/bridge', () => ({ runtime: { routerSummaries: vi.fn().mockResolvedValue([]), getAppState: vi.fn(), setAppState: vi.fn() } }))
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runtime.routerSummaries).mockResolvedValue([]); vi.mocked(runtime.getAppState).mockResolvedValue(null); vi.mocked(runtime.setAppState).mockResolvedValue(undefined) })
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
  expect(runtime.setAppState).toHaveBeenCalledWith(ROUTER_SETTINGS_KEY, JSON.stringify({ tokenBudget: 8192, model: 'gpt-6.1-terra', effort: 'low', descriptions: { '/hidden': 'keep me', '/a': 'Server implementation' } }))
})
it('reports a settings read failure', async () => {
  vi.mocked(runtime.getAppState).mockRejectedValue(new Error('read failed'))
  render(<RouterSettings models={[]} workspaces={[]} />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('read failed'))
  expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(true)
})
