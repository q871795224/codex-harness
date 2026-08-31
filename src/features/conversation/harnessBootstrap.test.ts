import { describe, expect, it, vi } from 'vitest'
import type { ThreadUiState, Workspace } from '../../core/domain/codex'
import {
  APPEARANCE_PREFERENCES_KEY,
  CONVERSATION_STATS_PREFERENCES_KEY,
  defaultNavigationPreferences,
  KEYBOARD_PREFERENCES_KEY,
  loadHarnessBootstrap,
  NAVIGATION_PREFERENCES_KEY,
  parseThreadTitleGenerationSettings,
  THREAD_TITLE_GENERATION_KEY,
  togglePinnedIdentifier,
  type HarnessBootstrapStorage,
} from './harnessBootstrap'

const workspace: Workspace = {
  root: '/repo', checkoutRoot: '/repo', name: 'repo', branch: 'main', sha: 'abc', createdAt: 1, lastOpenedAt: 1,
}
const threadState: ThreadUiState = { threadId: 'thread-1', lastReadAt: 42, badge: 'success' }

function storage(values: Record<string, string | null> = {}): HarnessBootstrapStorage {
  return {
    listWorkspaces: vi.fn().mockResolvedValue([workspace]),
    listThreadStates: vi.fn().mockResolvedValue([threadState]),
    getAppState: vi.fn(async (key: string) => values[key] ?? null),
  }
}

describe('Harness bootstrap restoration', () => {
  it('loads local state and normalizes stored preferences', async () => {
    const client = storage({
      selectedThreadId: 'thread-1',
      [NAVIGATION_PREFERENCES_KEY]: JSON.stringify({
        layout: 'list', sort: 'manual', manualThreadOrder: ['a', 'a', 42],
        workspaceSort: 'recent', pinnedThreadIds: ['thread-1', 'thread-1'], sidebarWidth: 900,
      }),
      [APPEARANCE_PREFERENCES_KEY]: JSON.stringify({ theme: 'dark' }),
      [KEYBOARD_PREFERENCES_KEY]: JSON.stringify({ sendShortcut: 'enter', followUpMode: 'interject' }),
      [THREAD_TITLE_GENERATION_KEY]: JSON.stringify({ model: 'custom', effort: 'high', prompt: 'Only a title' }),
      [CONVERSATION_STATS_PREFERENCES_KEY]: JSON.stringify({ enabled: true }),
    })

    const state = await loadHarnessBootstrap(client)

    expect(state.workspaces).toEqual([workspace])
    expect(state.threadStates).toEqual({ 'thread-1': threadState })
    expect(state.rememberedThreadId).toBe('thread-1')
    expect(state.navigation).toMatchObject({
      layout: 'list', sort: 'manual', manualThreadOrder: ['a'], workspaceSort: 'recent',
      pinnedThreadIds: ['thread-1'], sidebarWidth: 480,
    })
    expect(state.appearance.theme).toBe('dark')
    expect(state.keyboard).toMatchObject({ sendShortcut: 'enter', followUpMode: 'interject' })
    expect(state.threadTitleGeneration).toEqual({ model: 'custom', effort: 'high', prompt: 'Only a title' })
    expect(client.getAppState).toHaveBeenCalledTimes(6)
  })

  it('falls back safely when persisted JSON is damaged', async () => {
    const client = storage({
      [NAVIGATION_PREFERENCES_KEY]: '{broken',
      [APPEARANCE_PREFERENCES_KEY]: '{broken',
      [KEYBOARD_PREFERENCES_KEY]: '{broken',
      [THREAD_TITLE_GENERATION_KEY]: '{broken',
      [CONVERSATION_STATS_PREFERENCES_KEY]: '{broken',
    })

    const state = await loadHarnessBootstrap(client)

    expect(state.navigation).toEqual(defaultNavigationPreferences)
    expect(state.appearance.theme).toBe('light')
    expect(state.keyboard).toMatchObject({ sendShortcut: 'mod-enter', followUpMode: 'queue' })
    expect(state.threadTitleGeneration).toMatchObject({ model: 'gpt-5.6-luna', effort: 'low' })
  })
})

describe('bootstrap preference helpers', () => {
  it('toggles pinned identifiers without duplicates', () => {
    expect(togglePinnedIdentifier(['a', 'b'], 'a')).toEqual(['b'])
    expect(togglePinnedIdentifier(['a'], 'b')).toEqual(['b', 'a'])
  })

  it('defaults empty title-generation fields independently', () => {
    expect(parseThreadTitleGenerationSettings(JSON.stringify({ model: '', effort: '', prompt: '' }))).toMatchObject({
      model: 'gpt-5.6-luna', effort: 'low',
    })
  })
})
