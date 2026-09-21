// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { MemorySettings } from './MemorySettings'
import type { CodexModel } from '../../core/domain/codex'
import { DEFAULT_MEMORY_SETTINGS, MEMORY_SETTINGS_KEY } from '../../core/memory/settings'
vi.mock('../../core/runtime/bridge', () => ({ runtime: { getAppState: vi.fn(), setAppState: vi.fn() } }))
const models = [{ id: 'a', model: 'model-a', displayName: 'Model A', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] as CodexModel[]
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runtime.getAppState).mockResolvedValue(null); vi.mocked(runtime.setAppState).mockResolvedValue(undefined) })
afterEach(cleanup)
async function ready() {
  await waitFor(() => expect((screen.getByLabelText('模型') as HTMLSelectElement).disabled).toBe(false))
}
it('edits all extraction settings, adjusts effort for the model, and saves persistently', async () => {
  const view = render(<MemorySettings models={models} />)
  await ready()
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'model-a' } })
  expect((screen.getByLabelText('推理强度') as HTMLSelectElement).value).toBe('high')
  fireEvent.change(screen.getByLabelText('上下文轮数'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText('上下文预算（%）'), { target: { value: '50' } })
  fireEvent.change(screen.getByLabelText('上下文窗口（token）'), { target: { value: '100000' } })
  fireEvent.change(screen.getByLabelText('提炼提示词'), { target: { value: '只记录已经确认的结论' } })
  fireEvent.click(screen.getByText('保存设置'))
  await screen.findByText('已保存，下次提炼生效')
  const stored = vi.mocked(runtime.setAppState).mock.calls[0]
  expect(stored[0]).toBe(MEMORY_SETTINGS_KEY)
  expect(JSON.parse(stored[1])).toMatchObject({ model: 'model-a', effort: 'high', maxTurns: 8, budgetPercent: 50, contextWindowTokens: 100000, prompt: '只记录已经确认的结论' })
  view.unmount()
  vi.mocked(runtime.getAppState).mockResolvedValue(stored[1])
  render(<MemorySettings models={models} />)
  await ready()
  expect((screen.getByLabelText('上下文轮数') as HTMLInputElement).value).toBe('8')
})
it('restores defaults in the draft, rejects invalid numbers and surfaces save errors', async () => {
  render(<MemorySettings models={models} />)
  await ready()
  fireEvent.change(screen.getByLabelText('上下文预算（%）'), { target: { value: '101' } })
  fireEvent.click(screen.getByText('保存设置'))
  await screen.findByRole('alert')
  expect(runtime.setAppState).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('恢复默认'))
  expect((screen.getByLabelText('提炼提示词') as HTMLTextAreaElement).value).toBe(DEFAULT_MEMORY_SETTINGS.prompt)
  vi.mocked(runtime.setAppState).mockRejectedValueOnce(new Error('磁盘错误'))
  fireEvent.click(screen.getByText('保存设置'))
  await screen.findByText('磁盘错误')
  expect(screen.queryByText('已保存，下次提炼生效')).toBeNull()
})
