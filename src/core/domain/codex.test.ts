import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_SIZES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  emptyThreadDetail,
  isActive,
  itemText,
  normalizeFontSize,
  normalizeFontSizePreferences,
  normalizeSendShortcut,
  normalizeSidebarWidth,
  normalizeTheme,
  queueText,
  sortThreads,
  sortWorkspacesByRecentThread,
  textInput,
  threadTitle,
  threadsOlderThan,
  touchThreadActivity,
  type Thread,
  type Workspace,
} from './codex'

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    preview: '默认预览',
    cwd: '/workspace',
    name: null,
    createdAt: 0,
    updatedAt: 0,
    recencyAt: null,
    status: { type: 'idle' },
    ephemeral: false,
    canAcceptDirectInput: true,
    ...overrides,
  }
}

function makeWorkspace(root: string): Workspace {
  return {
    root,
    name: root.split('/').at(-1) ?? root,
    createdAt: 0,
    lastOpenedAt: 0,
  }
}

describe('threadTitle', () => {
  it('prefers a non-empty user supplied name', () => {
    expect(threadTitle(makeThread({ name: '  修复登录问题  ' }))).toBe('修复登录问题')
  })

  it('falls back to preview and then the new-thread label', () => {
    expect(threadTitle(makeThread({ name: ' ', preview: '首次请求' }))).toBe('首次请求')
    expect(threadTitle(makeThread({ name: null, preview: '  ' }))).toBe('新会话')
  })
})

describe('emptyThreadDetail', () => {
  it('creates a usable blank detail for a just-started thread', () => {
    const thread = makeThread({ id: 'new-thread', status: { type: 'idle' } })
    expect(emptyThreadDetail(thread)).toEqual({
      thread,
      turns: [],
      items: [],
      nextTurnsCursor: null,
      activeTurnId: null,
      foreignActive: false,
    })
  })
})

describe('normalizeFontSize', () => {
  it('keeps a whole-pixel value within the supported range', () => {
    expect(normalizeFontSize(16.4)).toBe(16)
    expect(normalizeFontSize(MIN_FONT_SIZE - 4)).toBe(MIN_FONT_SIZE)
    expect(normalizeFontSize(MAX_FONT_SIZE + 4)).toBe(MAX_FONT_SIZE)
  })

  it('migrates the former three size choices', () => {
    expect(normalizeFontSize('compact')).toBe(14)
    expect(normalizeFontSize('standard')).toBe(DEFAULT_FONT_SIZE)
    expect(normalizeFontSize('large')).toBe(16)
    expect(normalizeFontSize('unexpected')).toBe(DEFAULT_FONT_SIZE)
  })
})

describe('normalizeSidebarWidth', () => {
  it('uses the default for invalid values and clamps valid widths', () => {
    expect(normalizeSidebarWidth(undefined)).toBe(284)
    expect(normalizeSidebarWidth(120)).toBe(214)
    expect(normalizeSidebarWidth(500)).toBe(480)
    expect(normalizeSidebarWidth(284.7)).toBe(285)
  })
})

describe('normalizeFontSizePreferences', () => {
  it('keeps independently saved area values', () => {
    expect(normalizeFontSizePreferences({
      fontSizes: { navigation: 14, conversation: 17, settings: 16, plugins: 18 },
    })).toEqual({ navigation: 14, conversation: 17, settings: 16, plugins: 18 })
  })

  it('migrates the former global size without changing each area baseline', () => {
    expect(normalizeFontSizePreferences({ fontSize: 'large' })).toEqual({
      navigation: 14,
      conversation: 16,
      settings: 16,
      plugins: 16,
    })
    expect(normalizeFontSizePreferences({ fontSizes: { conversation: 17 } })).toEqual({
      ...DEFAULT_FONT_SIZES,
      conversation: 17,
    })
  })
})

describe('display and keyboard preferences', () => {
  it('uses stable defaults for unknown stored values', () => {
    expect(normalizeTheme('dark')).toBe('dark')
    expect(normalizeTheme('system')).toBe('light')
    expect(normalizeSendShortcut('enter')).toBe('enter')
    expect(normalizeSendShortcut('shift-enter')).toBe('mod-enter')
  })
})

describe('thread content helpers', () => {
  it('extracts user text in message order', () => {
    expect(itemText({ type: 'userMessage', content: [textInput('第一段'), textInput('第二段')] })).toBe('第一段\n第二段')
  })

  it('uses text for non-user items and joins queued inputs', () => {
    expect(itemText({ type: 'agentMessage', text: '回复内容' })).toBe('回复内容')
    expect(queueText({ id: 'queue-1', input: [textInput('继续'), textInput('执行')], clientUserMessageId: 'message-1' })).toBe('继续\n执行')
  })

  it('keeps attachment-only queue entries visible without leaking full paths', () => {
    expect(queueText({
      id: 'queue-2',
      input: [
        { type: 'localImage', path: '/private/tmp/design.png' },
        { type: 'mention', name: 'requirements.pdf', path: '/private/tmp/requirements.pdf' },
      ],
      clientUserMessageId: 'message-2',
    })).toBe('2 个附件')
  })
})

describe('isActive', () => {
  it('only treats active thread statuses as active', () => {
    expect(isActive({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe(true)
    expect(isActive({ type: 'idle' })).toBe(false)
  })
})

describe('thread list activity', () => {
  it('moves active threads ahead of newer idle threads in recent and manual modes', () => {
    const active = makeThread({ id: 'active', updatedAt: 10, recencyAt: 10, status: { type: 'active', activeFlags: [] } })
    const idle = makeThread({ id: 'idle', updatedAt: 20, recencyAt: 20 })

    expect(sortThreads([idle, active], 'recent', []).map((thread) => thread.id)).toEqual(['active', 'idle'])
    expect(sortThreads([idle, active], 'manual', ['idle', 'active']).map((thread) => thread.id)).toEqual(['active', 'idle'])
  })

  it('updates both server timestamps when local turn activity arrives', () => {
    const touched = touchThreadActivity(makeThread({ updatedAt: 10, recencyAt: 12 }), 30)

    expect(touched.updatedAt).toBe(30)
    expect(touched.recencyAt).toBe(30)
  })
})

describe('threadsOlderThan', () => {
  it('uses recency when available and leaves sessions at the cutoff untouched', () => {
    const cutoff = 1_700_000_000
    const oldByRecency = makeThread({ id: 'old-by-recency', updatedAt: cutoff + 10, recencyAt: cutoff - 1 })
    const oldByUpdate = makeThread({ id: 'old-by-update', updatedAt: cutoff - 1, recencyAt: null })
    const atCutoff = makeThread({ id: 'at-cutoff', updatedAt: cutoff, recencyAt: null })

    expect(threadsOlderThan([oldByRecency, oldByUpdate, atCutoff], cutoff).map((thread) => thread.id))
      .toEqual(['old-by-recency', 'old-by-update'])
  })
})

describe('sortWorkspacesByRecentThread', () => {
  it('orders a recent-workspace view by each workspace’s newest session', () => {
    const alpha = makeWorkspace('/work/alpha')
    const beta = makeWorkspace('/work/beta')
    const gamma = makeWorkspace('/work/gamma')
    const threads = [
      makeThread({ id: 'alpha-old', updatedAt: 10, recencyAt: 10 }),
      makeThread({ id: 'alpha-new', updatedAt: 30, recencyAt: 30 }),
      makeThread({ id: 'beta', updatedAt: 20, recencyAt: null }),
    ]

    expect(sortWorkspacesByRecentThread(
      [alpha, beta, gamma],
      threads,
      { 'alpha-old': alpha.root, 'alpha-new': alpha.root, beta: beta.root },
    ).map((workspace) => workspace.root)).toEqual([alpha.root, beta.root, gamma.root])
  })

  it('keeps the saved workspace order when recency is tied or unavailable', () => {
    const alpha = makeWorkspace('/work/alpha')
    const beta = makeWorkspace('/work/beta')
    const threads = [
      makeThread({ id: 'alpha', updatedAt: 20, recencyAt: null }),
      makeThread({ id: 'beta', updatedAt: 20, recencyAt: 20 }),
    ]

    expect(sortWorkspacesByRecentThread(
      [beta, alpha],
      threads,
      { alpha: alpha.root, beta: beta.root },
    ).map((workspace) => workspace.root)).toEqual([beta.root, alpha.root])
  })
})
