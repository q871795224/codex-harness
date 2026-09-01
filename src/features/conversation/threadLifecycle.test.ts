import { describe, expect, it, vi } from 'vitest'
import type { Thread, Turn } from '../../core/domain/codex'
import type { ResumeThreadResponse, StartThreadResponse } from '../../core/runtime/appServerClient'
import {
  resumedThreadDetail,
  resumeThreadWithRetry,
  resumeThreadRequest,
  activeThreadIdsForRecovery,
  runtimeThreadSettings,
  startedThreadDetail,
  threadPermissionOverrides,
  turnStartRequest,
} from './threadLifecycle'

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    cwd: '/repo',
    name: null,
    preview: '',
    ephemeral: false,
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: 'idle' },
    canAcceptDirectInput: true,
    ...overrides,
  }
}

function turn(id: string, status: Turn['status'], text: string): Turn {
  return {
    id,
    status,
    items: [{ id: `item-${id}`, type: 'agentMessage', text }],
    error: null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  }
}

function response(): ResumeThreadResponse {
  return {
    thread: thread(),
    initialTurnsPage: {
      data: [turn('turn-new', 'completed', 'new'), turn('turn-old', 'inProgress', 'old')],
      nextCursor: 'older-page',
    },
    runtimeWorkspaceRoots: ['/repo'],
    sandbox: { type: 'readOnly', networkAccess: false },
    activePermissionProfile: null,
    model: 'gpt-test',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
  }
}

describe('thread lifecycle hydration', () => {
  it('collects every active thread except the selected one for recovery', () => {
    const detail = resumedThreadDetail({ ...response(), thread: thread({ id: 'detail-thread' }) })
    const active = thread({ id: 'listed-active', status: { type: 'active', activeFlags: [] } })
    const idle = thread({ id: 'listed-idle' })

    expect(activeThreadIdsForRecovery(
      [active, idle],
      { 'owned-thread': 'turn-1' },
      { 'detail-thread': detail },
      'listed-active',
    )).toEqual(['owned-thread', 'detail-thread'])
  })

  it('builds a bounded full-history resume request for a known checkout', () => {
    expect(resumeThreadRequest('thread-1', '/repo')).toEqual({
      threadId: 'thread-1',
      cwd: '/repo',
      runtimeWorkspaceRoots: ['/repo'],
      initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' },
    })
  })

  it('retries a resume once after a transport failure', async () => {
    const resume = vi.fn()
      .mockRejectedValueOnce(new Error('Codex App Server 连接已关闭。'))
      .mockResolvedValueOnce(response())

    await expect(resumeThreadWithRetry(resume)).resolves.toEqual(response())
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-transport resume failure', async () => {
    const error = new Error('thread not found')
    const resume = vi.fn().mockRejectedValue(error)

    await expect(resumeThreadWithRetry(resume)).rejects.toBe(error)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('restores a descending history page into chronological UI state', () => {
    const detail = resumedThreadDetail(response())

    expect(detail.turns.map((item) => item.id)).toEqual(['turn-old', 'turn-new'])
    expect(detail.items.map((entry) => [entry.turnId, entry.item.id])).toEqual([
      ['turn-old', 'item-turn-old'],
      ['turn-new', 'item-turn-new'],
    ])
    expect(detail.activeTurnId).toBe('turn-old')
    expect(detail.foreignActive).toBe(true)
    expect(detail.nextTurnsCursor).toBe('older-page')
    expect(detail.threadSettings).toMatchObject({ effort: 'high', serviceTier: 'fast', sandboxMode: 'read-only' })
  })

  it('uses embedded turns when the server does not return a paged history', () => {
    const embedded = [turn('turn-1', 'completed', 'first'), turn('turn-2', 'completed', 'second')]
    const detail = resumedThreadDetail({ ...response(), thread: thread({ turns: embedded }), initialTurnsPage: null })

    expect(detail.turns).toEqual(embedded)
    expect(detail.nextTurnsCursor).toBeNull()
    expect(detail.activeTurnId).toBeNull()
    expect(detail.foreignActive).toBe(false)
  })

  it('creates an empty detail from a newly started thread response', () => {
    const started = startedThreadDetail(response() satisfies StartThreadResponse)

    expect(started.turns).toEqual([])
    expect(started.items).toEqual([])
    expect(started.runtimeWorkspaceRoots).toEqual(['/repo'])
    expect(started.model).toBe('gpt-test')
  })

  it('normalizes an omitted service tier from an older App Server', () => {
    expect(runtimeThreadSettings({ ...response(), serviceTier: undefined as unknown as null }).serviceTier).toBeNull()
  })
})

describe('thread workspace permissions', () => {
  it('keeps a named permission profile when the checkout changes', () => {
    const detail = startedThreadDetail({
      ...response(),
      activePermissionProfile: { id: 'profile-1', extends: null },
    })

    expect(threadPermissionOverrides(detail, '/repo', '/repo/worktree')).toEqual({ permissions: 'profile-1' })
  })

  it('refuses to expand an external sandbox into another checkout', () => {
    const detail = startedThreadDetail({ ...response(), sandbox: { type: 'externalSandbox', networkAccess: false } })

    expect(() => threadPermissionOverrides(detail, '/repo', '/repo/worktree')).toThrow('不能在原会话中扩大可写目录')
  })

  it('builds a turn request with the current checkout and permission context', () => {
    const currentThread = thread({ cwd: '/repo/worktree' })
    const detail = startedThreadDetail({
      ...response(),
      thread: currentThread,
      activePermissionProfile: { id: 'profile-1', extends: null },
    })
    const input = [{ type: 'localImage' as const, path: '/tmp/image.png' }]

    expect(turnStartRequest('thread-1', 'message-1', input, currentThread, detail)).toEqual({
      threadId: 'thread-1',
      clientUserMessageId: 'message-1',
      input,
      cwd: '/repo/worktree',
      runtimeWorkspaceRoots: ['/repo/worktree'],
      permissions: 'profile-1',
    })
  })
})
