import { describe, expect, it } from 'vitest'
import type { Thread, ThreadTokenUsage, Turn, Workspace } from '../../core/domain/codex'
import {
  CONVERSATION_STAT_DEFINITIONS,
  conversationStatSegments,
  defaultConversationStatsPreferences,
  normalizeConversationStatsPreferences,
} from './conversationStatsConfig'

const tokenUsage: ThreadTokenUsage = {
  total: {
    totalTokens: 12_000,
    inputTokens: 10_000,
    cachedInputTokens: 7_500,
    cacheWriteInputTokens: 600,
    outputTokens: 2_000,
    reasoningOutputTokens: 900,
  },
  last: {
    totalTokens: 4_000,
    inputTokens: 3_200,
    cachedInputTokens: 2_400,
    cacheWriteInputTokens: 100,
    outputTokens: 800,
    reasoningOutputTokens: 300,
  },
  modelContextWindow: 20_000,
}

const turn: Turn = {
  id: 'turn-1',
  items: [],
  status: 'completed',
  error: null,
  startedAt: 1,
  completedAt: 3,
  durationMs: 2_000,
}

const thread: Thread = {
  id: 'thread-1', preview: '', cwd: '/repo', name: null, createdAt: 1, updatedAt: 2, recencyAt: 2,
  status: { type: 'active', activeFlags: [] }, ephemeral: false, canAcceptDirectInput: true,
  gitInfo: { branch: 'feature/stats', sha: 'abc' },
}

const workspace: Workspace = {
  root: '/repo', checkoutRoot: '/repo', name: 'codex-harness', branch: 'feature/stats', sha: 'abc',
  createdAt: 1, lastOpenedAt: 2,
}

describe('conversation stats preferences', () => {
  it('provides every available field once and restores new fields after older saved preferences', () => {
    const defaults = defaultConversationStatsPreferences()
    expect(defaults.items.map((item) => item.id)).toEqual(CONVERSATION_STAT_DEFINITIONS.map((definition) => definition.id))

    expect(normalizeConversationStatsPreferences({
      items: [
        { id: 'credits', visible: true },
        { id: 'activity', visible: false },
        { id: 'credits', visible: false },
        { id: 'removed-field', visible: true },
      ],
    }).items.slice(0, 2)).toEqual([
      { id: 'credits', visible: true },
      { id: 'activity', visible: false },
    ])
  })

  it('renders only enabled fields with real values and preserves configured order', () => {
    const preferences = normalizeConversationStatsPreferences({
      items: [
        { id: 'usd', visible: true },
        { id: 'contextUsage', visible: true },
        { id: 'cacheHitRate', visible: true },
        { id: 'activity', visible: false },
      ],
    })
    const segments = conversationStatSegments(preferences, {
      turns: [turn],
      items: [{ turnId: turn.id, item: { id: 'tool-1', type: 'commandExecution', durationMs: 1_500 } }],
      tokenUsage,
      creditUsage: { creditsMicros: 1_250_000, usdMicros: 250_000 },
      thread,
      workspace,
      taskPlan: null,
    })

    expect(segments.slice(0, 3).map((segment) => segment.text)).toEqual([
      '$0.25 USD',
      '上下文 4K / 20K · 20%',
      '缓存命中 75%',
    ])
    expect(segments.some((segment) => segment.id === 'activity')).toBe(false)
  })

  it('omits enabled fields when the App Server has no value for them', () => {
    const preferences = normalizeConversationStatsPreferences({ items: [{ id: 'usd', visible: true }] })
    expect(conversationStatSegments(preferences, {
      turns: [],
      items: [],
      tokenUsage: null,
      creditUsage: { creditsMicros: 0, usdMicros: null },
      thread: null,
      workspace: null,
      taskPlan: null,
    }).some((segment) => segment.id === 'usd')).toBe(false)
  })

  it('renders no footer for a new thread even when account usage reports zero credits', () => {
    const preferences = defaultConversationStatsPreferences()
    expect(conversationStatSegments(preferences, {
      turns: [],
      items: [],
      tokenUsage: null,
      creditUsage: { creditsMicros: 0, usdMicros: 0 },
      thread,
      workspace,
      taskPlan: null,
    })).toEqual([])
  })

  it('formats App Server and workspace status fields after conversation activity starts', () => {
    const preferences = normalizeConversationStatsPreferences({ items: [
      { id: 'projectName', visible: true },
      { id: 'gitBranch', visible: true },
      { id: 'runState', visible: true },
      { id: 'taskProgress', visible: true },
      { id: 'usedTokens', visible: true },
    ] })
    const segments = conversationStatSegments(preferences, {
      turns: [turn], items: [], tokenUsage, creditUsage: null, thread, workspace,
      taskPlan: [
        { step: '定位问题', status: 'completed' },
        { step: '修改实现', status: 'inProgress' },
        { step: '验证', status: 'pending' },
      ],
    })
    expect(segments.slice(0, 5).map((segment) => segment.text)).toEqual([
      '项目 codex-harness',
      '分支 feature/stats',
      '状态 工作中',
      '任务 1/3 · 修改实现',
      '已用 12K tok',
    ])
  })
})
