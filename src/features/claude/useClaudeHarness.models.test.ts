// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { textInput } from '../../core/domain/codex'
import type { ClaudeModel, ClaudeSessionRecord } from '../../core/claude/types'
import { useClaudeHarness } from './useClaudeHarness'

vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  getAppState: vi.fn(), setAppState: vi.fn(),
  listenClaudeEvents: vi.fn().mockResolvedValue(() => {}),
  listenClaudeTransport: vi.fn().mockResolvedValue(() => {}),
  claudeRuntimeStatus: vi.fn().mockResolvedValue({ available: true }),
  claudeRequest: vi.fn().mockResolvedValue({ activeTurns: [], pendingApprovals: [] }),
  listClaudeSessions: vi.fn(), listClaudeModels: vi.fn(), upsertClaudeSession: vi.fn(),
  readClaudeHistory: vi.fn().mockResolvedValue({ messages: [] }),
  readClaudeContext: vi.fn().mockResolvedValue(null),
  startClaudeTurn: vi.fn().mockResolvedValue(undefined),
} }))

const settingsKey = 'claude.sessionSettings'
const session: ClaudeSessionRecord = { id: 'claude:fixture', providerSessionId: 'native-session',
  cwd: '/repo', title: 'fixture', archived: false, createdAt: 1, updatedAt: 1 }
const model = (value: string, resolvedModel: string): ClaudeModel => ({ value, resolvedModel, displayName: value,
  description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'],
  supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: false })
let storage: Map<string, string>

beforeEach(() => {
  vi.clearAllMocks()
  storage = new Map([[settingsKey, JSON.stringify({ [session.id]: { model: 'claude-fable-5-2[1M]', effort: 'medium', permissionMode: 'bypassPermissions' } })]])
  vi.mocked(runtime.getAppState).mockImplementation(async key => storage.get(key) ?? null)
  vi.mocked(runtime.setAppState).mockImplementation(async (key, value) => { storage.set(key, value) })
  vi.mocked(runtime.listClaudeSessions).mockResolvedValue([session])
  vi.mocked(runtime.listClaudeModels).mockResolvedValue({ models: [model('default', 'claude-opus-5-5[1m]'), model('fable', 'claude-fable-5-2[1M]')] })
  vi.mocked(runtime.upsertClaudeSession).mockImplementation(async input => ({ ...session, ...input }))
})
afterEach(cleanup)

it('keeps a persisted model and effort even when absent from the catalog, including after remount', async () => {
  vi.mocked(runtime.listClaudeModels).mockResolvedValue({ models: [model('default', 'different-model')] })
  for (let i = 0; i < 2; i++) {
    const { result, unmount } = renderHook(() => useClaudeHarness())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.sendMessage(session.id, [textInput('continue')], 'queue') })
    expect(runtime.startClaudeTurn).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'claude-fable-5-2[1M]', effort: 'medium' }))
    unmount()
  }
})

it('does not inject low when no effort was selected', async () => {
  storage.set(settingsKey, JSON.stringify({ [session.id]: { model: 'fable', effort: null } }))
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  await act(async () => { await result.current.sendMessage(session.id, [textInput('continue')], 'queue') })
  expect(runtime.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ model: 'fable' }))
  expect(vi.mocked(runtime.startClaudeTurn).mock.calls[0][0]).not.toHaveProperty('effort')
})

it('saves the chosen global model as a concrete request ID before a new session can send', async () => {
  storage.set('claude.defaultModel', 'fable')
  storage.set('claude.defaultEffort', 'medium')
  const { result, unmount } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  let id = ''
  await act(async () => { id = await result.current.createSession('/repo') })
  expect(JSON.parse(storage.get(settingsKey)!)[id]).toEqual({ model: 'claude-fable-5-2[1M]', modelOption: 'fable', modelDisplayName: 'fable', effort: 'medium', permissionMode: 'bypassPermissions' })
  const saved = { ...session, id }
  unmount()
  storage.set('claude.defaultModel', 'opus')
  vi.mocked(runtime.listClaudeSessions).mockResolvedValue([saved])
  vi.mocked(runtime.listClaudeModels).mockResolvedValue({ models: [] })
  const restored = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(restored.result.current.loaded).toBe(true))
  expect(restored.result.current.settingsForSession(id)).toMatchObject({ modelOption: 'fable', modelDisplayName: 'fable' })
  await act(async () => { await restored.result.current.sendMessage(id, [textInput('continue')], 'queue') })
  expect(runtime.startClaudeTurn).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'claude-fable-5-2[1M]', effort: 'medium' }))
})

it('snapshots the SDK default by identity rather than catalog position', async () => {
  vi.mocked(runtime.listClaudeModels).mockResolvedValue({ models: [model('other', 'other-model'), model('default', 'actual-default')] })
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  let id = ''
  await act(async () => { id = await result.current.createSession('/repo') })
  expect(JSON.parse(storage.get(settingsKey)!)[id]).toMatchObject({ model: 'actual-default', effort: null })
})

it.each([null, 'default'])('requires an explicit choice for legacy sessions without a fixed model (%s)', async model => {
  storage.set(settingsKey, JSON.stringify({ [session.id]: { model, effort: null } }))
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  await act(async () => { await expect(result.current.sendMessage(session.id, [textInput('continue')], 'queue')).rejects.toThrow('请先选择模型') })
  expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
  await act(async () => { result.current.updateSessionSettings(session.id, { model: 'fable', effort: 'medium' }) })
  await act(async () => { await result.current.sendMessage(session.id, [textInput('continue')], 'queue') })
  expect(runtime.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-fable-5-2[1M]', effort: 'medium' }))
})

it('does not send when the saved settings could not be read', async () => {
  vi.mocked(runtime.getAppState).mockRejectedValueOnce(new Error('read failed'))
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  await act(async () => { await expect(result.current.sendMessage(session.id, [textInput('continue')], 'queue')).rejects.toThrow('无法读取 Claude 会话模型设置') })
  expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
})

it('waits for settings hydration before allowing a continuation', async () => {
  let hydrate!: (value: string) => void
  vi.mocked(runtime.getAppState).mockImplementation(key => key === settingsKey ? new Promise(resolve => { hydrate = resolve }) : Promise.resolve(null))
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  let sending!: Promise<void>
  act(() => { sending = result.current.sendMessage(session.id, [textInput('continue')], 'queue') })
  expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
  await act(async () => { hydrate(storage.get(settingsKey)!); await sending })
  expect(runtime.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-fable-5-2[1M]' }))
})

it('blocks sending after a failed settings write instead of using an unpersisted selection', async () => {
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  vi.mocked(runtime.setAppState).mockRejectedValueOnce(new Error('disk failed'))
  await act(async () => { result.current.updateSessionSettings(session.id, { model: 'another-model' }) })
  await act(async () => { await expect(result.current.sendMessage(session.id, [textInput('continue')], 'queue')).rejects.toThrow('disk failed') })
  expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
})
