// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { HistorySettings } from './HistorySettings'

vi.mock('../../core/runtime/bridge', () => ({ runtime: { getAppState: vi.fn(), setAppState: vi.fn() } }))
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runtime.getAppState).mockResolvedValue(null) })
afterEach(cleanup)

it('saves the mode and a custom size, then restores them when reopened', async () => {
  const first = render(<HistorySettings />)
  const save = screen.getByRole('button', { name: '保存设置' })
  await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false))
  fireEvent.change(screen.getByLabelText('历史加载方式'), { target: { value: 'eager' } })
  fireEvent.change(screen.getByLabelText('响应上限（MiB）'), { target: { value: '250' } })
  fireEvent.click(save)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
  const saved = vi.mocked(runtime.setAppState).mock.calls[0][1]
  expect(JSON.parse(saved)).toEqual({ loading: 'eager', maxResponseMiB: 250 })
  first.unmount()
  vi.mocked(runtime.getAppState).mockResolvedValue(saved)
  render(<HistorySettings />)
  await waitFor(() => expect((screen.getByLabelText('响应上限（MiB）') as HTMLInputElement).value).toBe('250'))
  expect((screen.getByLabelText('历史加载方式') as HTMLSelectElement).value).toBe('eager')
})

it('shows validation and storage failures without claiming settings were saved', async () => {
  render(<HistorySettings />)
  const save = screen.getByRole('button', { name: '保存设置' })
  await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false))
  fireEvent.change(screen.getByLabelText('响应上限（MiB）'), { target: { value: '4' } })
  fireEvent.click(save)
  expect((await screen.findByRole('alert')).textContent).toContain('16–1024')
  expect(runtime.setAppState).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('响应上限（MiB）'), { target: { value: '256' } })
  vi.mocked(runtime.setAppState).mockRejectedValue(new Error('storage failed'))
  fireEvent.click(save)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('storage failed'))
  expect(screen.queryByRole('status')).toBeNull()
})
