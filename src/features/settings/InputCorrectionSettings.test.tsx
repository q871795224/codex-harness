// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InputCorrectionSettings } from './InputCorrectionSettings'
import { loadCorrectionSettings, saveCorrectionSettings } from '../../core/input-correction/settings'
const settings = { enabled: true, quotes: true, rules: [{ from: '哈尼斯', to: 'Harness' }] }
vi.mock('../../core/input-correction/settings', () => ({ useCorrectionSettings: () => settings, loadCorrectionSettings: vi.fn(), saveCorrectionSettings: vi.fn() }))
beforeEach(() => { vi.clearAllMocks(); vi.mocked(loadCorrectionSettings).mockResolvedValue(); vi.mocked(saveCorrectionSettings).mockResolvedValue() })
afterEach(cleanup)
it('reads saved rules and persists additions, changes and deletions', async () => {
  render(<InputCorrectionSettings />)
  const save = screen.getByRole('button', { name: '保存词库' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  const editor = screen.getByRole('textbox', { name: '替换词库' }) as HTMLTextAreaElement
  expect(editor.value).toBe('哈尼斯 → Harness')
  fireEvent.change(editor, { target: { value: '哈尼斯 → Codex Harness\n绘画 -> 会话' } })
  fireEvent.click(save)
  await waitFor(() => expect(saveCorrectionSettings).toHaveBeenLastCalledWith({ ...settings, rules: [{ from: '哈尼斯', to: 'Codex Harness' }, { from: '绘画', to: '会话' }] }))
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  fireEvent.change(editor, { target: { value: '' } })
  fireEvent.click(save)
  await waitFor(() => expect(saveCorrectionSettings).toHaveBeenLastCalledWith({ ...settings, rules: [] }))
})
it('rejects malformed rules without overwriting the saved dictionary', async () => {
  render(<InputCorrectionSettings />)
  const save = screen.getByRole('button', { name: '保存词库' })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  fireEvent.change(screen.getByRole('textbox', { name: '替换词库' }), { target: { value: '没有替换目标' } })
  fireEvent.click(save)
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(saveCorrectionSettings).not.toHaveBeenCalled()
})
