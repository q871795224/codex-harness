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
    return <SessionLauncher radar={radar} storage={storage} threadId="selection-test" threadCwd={null} workspaceRoot={null} isNewThread models={models} settings={settings} disabled={false} onSettingsChange={(patch) => { changed(patch); setSettings((old) => ({ ...old, ...patch })) }} />
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
