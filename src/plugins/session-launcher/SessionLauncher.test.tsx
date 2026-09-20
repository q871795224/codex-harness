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
  const radar = { modelTable: vi.fn(async () => ({ fetchedAt: 1, rows: models.map((m, i) => ({ group: 'reference' as const, model: m.model, effort: 'low', iq: 100 + i * 5, price: 1 + i, minutes: 1, bestIq: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor: i === 0 })) })) }
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
  const radar = { modelTable: vi.fn(async () => ({ fetchedAt: 1, rows: [{ group: 'reference' as const, model: 'gpt-6-astra', effort: 'low', iq: 100, price: 1, minutes: 1, bestIq: true, bestPrice: true, bestMinutes: true, automatic: false, defaultCursor: true }] })) }
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
