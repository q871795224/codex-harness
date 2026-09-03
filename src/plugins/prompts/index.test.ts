import { describe, expect, it } from 'vitest'
import type { ComposerCompletionContribution, ConversationTabContribution, PluginInstanceContext, PluginStorage } from '../../extensions/types'
import {
  createPromptStore,
  firstLineOf,
  loadPromptItems,
  normalizePromptItems,
  promptsPlugin,
  shouldCollapsePrompt,
  type PromptItem,
} from './index'

function prompt(id: string, scope: PromptItem['scope'], overrides: Partial<PromptItem> = {}): PromptItem {
  return {
    id,
    title: `标题-${id}`,
    body: `正文-${id}`,
    scope,
    workspaceRoot: scope === 'workspace' ? '/repo' : null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function mapStorage(initial: Record<string, unknown> = {}): PluginStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial))
  return {
    data,
    async get<T>(key: string) { return (data.has(key) ? data.get(key) : null) as T | null },
    async set<T>(key: string, value: T) { data.set(key, value) },
  }
}

function fakeContext(storage: PluginStorage) {
  const completions: ComposerCompletionContribution[] = []
  const tabs: ConversationTabContribution[] = []
  const noop = () => () => undefined
  const ctx: PluginInstanceContext = {
    pluginId: 'builtin.prompts',
    instanceId: 'builtin.prompts:default',
    scope: { kind: 'global' },
    config: {},
    services: {
      provide: () => undefined,
      get: () => { throw new Error('unused') },
      optional: () => undefined,
    },
    events: { on: () => undefined, emit: () => undefined },
    slots: {
      threadHeaderActions: { register: noop },
      newThreadPanels: { register: noop },
      conversationTabs: { register: (contribution) => { tabs.push(contribution) } },
      composerActions: { register: noop },
      composerCompletions: { register: (contribution) => { completions.push(contribution) } },
      quickActions: { register: noop },
      quickCommands: { register: noop },
    },
    commands: { register: () => undefined },
    storage,
    signal: new AbortController().signal,
    effect: () => undefined,
  }
  return { ctx, completions, tabs }
}

describe('prompts plugin activation', () => {
  it('registers a # completion provider and a management tab', () => {
    const { ctx, completions, tabs } = fakeContext(mapStorage())
    promptsPlugin.activate(ctx)

    expect(completions).toHaveLength(1)
    expect(completions[0].trigger).toBe('#')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].label).toBe('提示词')
    expect(promptsPlugin.manifest.supportedProviders).toBeUndefined()
  })
})

describe('loadPromptItems', () => {
  const context = { provider: 'codex' as const, threadId: 'thread-1', threadCwd: '/repo', workspaceRoot: '/repo' }

  it('groups workspace items before global ones and hides other workspaces', async () => {
    const storage = mapStorage({ 'prompts.v1': [
      prompt('global-a', 'global'),
      prompt('workspace-here', 'workspace', { workspaceRoot: '/repo' }),
      prompt('workspace-elsewhere', 'workspace', { workspaceRoot: '/other' }),
    ] })
    const store = createPromptStore(storage)

    const items = await loadPromptItems(store, '', context)

    expect(items.map((item) => [item.id, item.group])).toEqual([
      ['workspace-here', '本工作区'],
      ['global-a', '全局'],
    ])
  })

  it('omits the workspace group outside any workspace', async () => {
    const storage = mapStorage({ 'prompts.v1': [prompt('global-a', 'global'), prompt('workspace-a', 'workspace')] })
    const store = createPromptStore(storage)

    const items = await loadPromptItems(store, '', { ...context, workspaceRoot: null })

    expect(items.map((item) => item.id)).toEqual(['global-a'])
  })

  it('matches the query against title and body, case-insensitively', async () => {
    const storage = mapStorage({ 'prompts.v1': [
      prompt('by-title', 'global', { title: '发布检查清单' }),
      prompt('by-body', 'global', { title: 'weekly', body: '包含 RELEASE 注意事项' }),
      prompt('miss', 'global', { title: '无关', body: '没关系' }),
    ] })
    const store = createPromptStore(storage)

    expect((await loadPromptItems(store, '发布', context)).map((item) => item.id)).toEqual(['by-title'])
    expect((await loadPromptItems(store, 'release', context)).map((item) => item.id)).toEqual(['by-body'])
  })

  it('marks long bodies for collapsing and previews the first line', async () => {
    const longBody = `第一行\n${'x'.repeat(300)}`
    const storage = mapStorage({ 'prompts.v1': [
      prompt('long', 'global', { body: longBody }),
      prompt('short', 'global', { body: '短正文' }),
    ] })
    const store = createPromptStore(storage)

    const items = await loadPromptItems(store, '', context)
    const long = items.find((item) => item.id === 'long')!
    const short = items.find((item) => item.id === 'short')!

    expect(long.collapseAsPaste).toBe(true)
    expect(long.insertText).toBe(longBody)
    expect(long.subtitle).toBe('第一行')
    expect(short.collapseAsPaste).toBe(false)
  })
})

describe('createPromptStore', () => {
  it('loads persisted items once and notifies subscribers on commit', async () => {
    const storage = mapStorage({ 'prompts.v1': [prompt('saved', 'global')] })
    const store = createPromptStore(storage)
    const seen: string[][] = []
    store.subscribe(() => seen.push(store.getSnapshot().map((item) => item.id)))

    expect(store.getSnapshot()).toEqual([])
    expect((await store.ensureLoaded()).map((item) => item.id)).toEqual(['saved'])
    expect((await store.ensureLoaded()).map((item) => item.id)).toEqual(['saved'])

    await store.commit([prompt('saved', 'global'), prompt('added', 'global', { updatedAt: 1 })])
    expect(store.getSnapshot().map((item) => item.id)).toEqual(['saved', 'added'])
    expect(seen.at(-1)).toEqual(['saved', 'added'])

    const persisted = storage.data.get('prompts.v1') as PromptItem[]
    expect(persisted.map((item) => item.id)).toEqual(['saved', 'added'])
  })

  it('drops malformed records when loading', () => {
    expect(normalizePromptItems([
      prompt('valid', 'global'),
      { id: 1, title: 'bad' },
      null,
      { id: 'x', title: 't', body: 'b', scope: 'thread' },
    ]).map((item) => item.id)).toEqual(['valid'])
    expect(normalizePromptItems('not-an-array')).toEqual([])
  })
})

describe('prompt display helpers', () => {
  it('collapses at 300 chars or 3 lines', () => {
    expect(shouldCollapsePrompt('a'.repeat(299))).toBe(false)
    expect(shouldCollapsePrompt('a'.repeat(300))).toBe(true)
    expect(shouldCollapsePrompt('一行\n两行')).toBe(false)
    expect(shouldCollapsePrompt('一行\n两行\n三行')).toBe(true)
  })

  it('previews only the first line with a length cap', () => {
    expect(firstLineOf('首行\n次行')).toBe('首行')
    expect(firstLineOf(`  ${'长'.repeat(80)}  `)).toHaveLength(61)
  })
})
