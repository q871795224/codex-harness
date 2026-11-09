// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InputCorrectionSettings } from './InputCorrectionSettings'
import { initializeDictionary } from '../../core/input-correction/initialize'
import { loadCorrectionSettings, saveCorrectionSettings } from '../../core/input-correction/settings'
vi.mock('../../core/input-correction/initialize', () => ({ initializeDictionary: vi.fn() }))
// Keep the external store snapshot stable, just like useSyncExternalStore.
const settings = { enabled: true, quotes: true, initialized: false, rules: [{ from: '哈尼斯', to: 'Harness' }] }
vi.mock('../../core/input-correction/settings', () => ({ useCorrectionSettings: () => settings, loadCorrectionSettings: vi.fn(), saveCorrectionSettings: vi.fn() }))
beforeEach(() => { vi.clearAllMocks(); vi.mocked(loadCorrectionSettings).mockResolvedValue(); vi.mocked(saveCorrectionSettings).mockResolvedValue(); vi.mocked(initializeDictionary).mockResolvedValue([{ from: '绘画', to: '会话' }]) })
afterEach(cleanup)
it('only calls the model on explicit initialization and saves reviewed candidates separately', async () => {
  render(<InputCorrectionSettings cwd="/repo" />)
  const button = screen.getByRole('button', { name: '从历史初始化词库' })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  expect(initializeDictionary).not.toHaveBeenCalled()
  fireEvent.click(button)
  await waitFor(() => expect((screen.getByRole('textbox', { name: '替换词库' }) as HTMLTextAreaElement).value).toContain('绘画 → 会话'))
  expect(saveCorrectionSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保存词库' }))
  await waitFor(() => expect(saveCorrectionSettings).toHaveBeenCalledWith(expect.objectContaining({ initialized: true, rules: [{ from: '绘画', to: '会话' }, { from: '哈尼斯', to: 'Harness' }] })))
})
it('manual edits do not consume the one-time model initialization', async () => {
  render(<InputCorrectionSettings cwd="/repo" />)
  const save = screen.getByRole('button', { name: '保存词库' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  fireEvent.change(screen.getByRole('textbox', { name: '替换词库' }), { target: { value: '绘画 -> 会话' } })
  fireEvent.click(save)
  await waitFor(() => expect(saveCorrectionSettings).toHaveBeenCalledWith(expect.objectContaining({ initialized: false, rules: [{ from: '绘画', to: '会话' }] })))
  expect(initializeDictionary).not.toHaveBeenCalled()
})
