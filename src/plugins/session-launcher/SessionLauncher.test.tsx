// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { CodexModel, ThreadCodexSettings } from '../../core/domain/codex'
import type { PluginStorage } from '../../extensions/types'
import { SessionLauncher } from './index'

afterEach(cleanup)
it('defaults over inherited settings once, then preserves manual choices across refresh and remount', async () => {
  const models: CodexModel[] = ['gpt-5.6-sol', 'gpt-6-astra'].map((model) => ({ id: model, model, displayName: model, description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }], defaultReasoningEffort: 'low', inputModalities: ['text'], isDefault: false }))
  const radar = { modelTable: vi.fn(async () => ({ fetchedAt: 1, rows: models.map((m, i) => ({ group: 'reference' as const, model: m.model, effort: 'low', score: 100 + i * 5, coverage: 50, price: 1 + i, minutes: 1, bestScore: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor: i === 0 })) })) }
  const values = new Map<string, unknown>()
  const storage: PluginStorage = { get: async <T,>(key: string) => (values.get(key) ?? null) as T | null, set: async (key, value) => { values.set(key, value) } }
  const changed = vi.fn()
  function Host() {
    const [settings, setSettings] = useState<ThreadCodexSettings>({ model: 'gpt-5.6-sol', effort: 'low', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access', serviceTier: null })
    return <SessionLauncher radar={radar} storage={storage} notifications={{ publish: vi.fn() }} threadId="selection-test" threadCwd={null} workspaceRoot={null} isNewThread models={models} settings={settings} disabled={false} onSettingsChange={(patch) => { changed(patch); setSettings((old) => ({ ...old, ...patch })) }} />
  }
  const first = render(<Host />)
  await waitFor(() => expect(changed).toHaveBeenCalledWith({ model: 'gpt-6-astra', effort: 'low' }))
  await waitFor(() => expect(values.get('model-initialized:selection-test')).toBe(true))
  const manual = screen.getByRole('button', { name: /Sol.*low/i })
  fireEvent.click(manual)
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ model: 'gpt-5.6-sol', effort: 'low' }))
  first.unmount()
  changed.mockClear()
  render(<Host />)
  await waitFor(() => expect(radar.modelTable).toHaveBeenCalledTimes(2))
  await screen.findByRole('button', { name: /Sol.*low/i })
  expect(changed).not.toHaveBeenCalled()
})

it.each(['async', 'sync'] as const)('stops after %s initialization failure across rerenders/remounts, notifies once, and allows manual selection', async (failure) => {
  const models: CodexModel[] = [{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'Astra', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }], defaultReasoningEffort: 'low', inputModalities: ['text'], isDefault: true }]
  const radar = { modelTable: vi.fn(async () => ({ fetchedAt: 1, rows: [{ group: 'reference' as const, model: 'gpt-6-astra', effort: 'low', score: 100, coverage: 50, price: 1, minutes: 1, bestScore: true, bestPrice: true, bestMinutes: true, automatic: false, defaultCursor: true }] })) }
  const storage: PluginStorage = { get: vi.fn(async () => null), set: vi.fn(async () => {}) }
  const notifications = { publish: vi.fn(() => 'notice') }
  const changed = vi.fn().mockImplementationOnce(() => {
    if (failure === 'sync') throw new Error('thread not found')
    return Promise.reject(new Error('thread not found'))
  }).mockResolvedValue(undefined)
  function Host() {
    const [settings, setSettings] = useState<ThreadCodexSettings>({ model: 'gpt-6-astra', effort: 'low', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access', serviceTier: null })
    return <SessionLauncher radar={radar} storage={storage} notifications={notifications} threadId={`failure-${failure}`} threadCwd={null} workspaceRoot="/repo" isNewThread models={models} settings={settings} disabled={false} onSettingsChange={(patch) => {
      setSettings((previous) => ({ ...previous }))
      return changed(patch)
    }} />
  }
  const first = render(<Host />)
  await waitFor(() => expect(notifications.publish).toHaveBeenCalledTimes(1))
  expect(notifications.publish).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', threadId: `failure-${failure}`, workspaceRoot: '/repo', details: expect.stringContaining('thread not found') }))
  first.rerender(<Host />)
  fireEvent.click(screen.getByRole('button', { name: '刷新 Radar 数据' }))
  await waitFor(() => expect(radar.modelTable).toHaveBeenCalledTimes(2))
  expect(radar.modelTable).toHaveBeenNthCalledWith(1, false)
  expect(radar.modelTable).toHaveBeenNthCalledWith(2, true)
  first.unmount()
  render(<Host />)
  await waitFor(() => expect(radar.modelTable).toHaveBeenCalledTimes(3))
  await screen.findByRole('button', { name: /Astra.*low/i })
  expect(changed).toHaveBeenCalledTimes(1)
  expect(storage.set).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Astra.*low/i }))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(storage.set).toHaveBeenCalledWith(`model-initialized:failure-${failure}`, true))
  expect(notifications.publish).toHaveBeenCalledTimes(1)
})

it('renders Bench scores and coverage while leaving unavailable metrics blank', async () => {
  const models: CodexModel[] = [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'Sol', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'high', inputModalities: ['text'], isDefault: true }]
  const radar = { modelTable: vi.fn(async () => ({ fetchedAt: 1, rows: [{ group: 'reference' as const, model: 'gpt-6.1-sol', effort: 'high', score: 104.5647, coverage: 50, price: null, minutes: null, bestScore: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor: true }] })) }
  render(<SessionLauncher radar={radar} storage={{ get: async () => null, set: async () => {} }} notifications={{ publish: vi.fn() }} threadId="bench-render" threadCwd={null} workspaceRoot={null} isNewThread models={models} settings={{ model: 'gpt-6.1-sol', effort: 'high', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access', serviceTier: null }} disabled={false} onSettingsChange={vi.fn()} />)
  expect(await screen.findByRole('button', { name: /6.1 Sol.*high/i })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: '雷达分' })).toBeTruthy()
  expect(screen.queryByRole('columnheader', { name: 'IQ' })).toBeNull()
  expect(screen.getByTitle('覆盖 50/64 道题').textContent).toBe('104.6')
  expect(screen.getAllByText('—')).toHaveLength(2)
  expect(screen.getByText(/COST 为 API 等价费用/)).toBeTruthy()
})


it('shows incomplete refresh results, preserves the table on failure, and clears the warning on recovery', async () => {
  const model = 'gpt-6-luna'
  const models: CodexModel[] = [{ id: model, model, displayName: model, description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'max', description: '' }], defaultReasoningEffort: 'max', inputModalities: ['text'], isDefault: true }]
  const row = { group: 'simple' as const, model, effort: 'max', score: 53, coverage: 58, price: 1, minutes: 2, bestScore: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor: false }
  const radar = { modelTable: vi.fn()
    .mockResolvedValueOnce({ fetchedAt: 1, rows: [row] })
    .mockResolvedValueOnce({ fetchedAt: 2, rows: [{ ...row, score: 55 }], warnings: ['gpt-6.1-sol / high: http: 502'] })
    .mockRejectedValueOnce(new Error('binding HTTP 502'))
    .mockResolvedValueOnce({ fetchedAt: 3, rows: [{ ...row, score: 56 }], warnings: [] }) }
  render(<SessionLauncher radar={radar} storage={{ get: async () => null, set: async () => {} }} notifications={{ publish: vi.fn() }} threadId={null} threadCwd={null} workspaceRoot={null} isNewThread models={models} settings={{ model, effort: 'max', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access', serviceTier: null }} disabled={false} onSettingsChange={vi.fn()} />)
  await screen.findByText('53.0')
  const refresh = screen.getByRole('button', { name: '刷新 Radar 数据' })
  fireEvent.click(refresh)
  await screen.findByText('55.0')
  expect(screen.getByText(/Radar 数据不完整/).getAttribute('title')).toBe('gpt-6.1-sol / high: http: 502')
  fireEvent.click(refresh)
  await screen.findByText('Radar 更新失败，保留上次数据。')
  expect(screen.getByText('55.0')).toBeTruthy()
  fireEvent.click(refresh)
  await screen.findByText('56.0')
  expect(screen.queryByText(/Radar 数据不完整|Radar 更新失败/)).toBeNull()
  expect(radar.modelTable.mock.calls.map(([force]) => force)).toEqual([false, true, true, true])
})
