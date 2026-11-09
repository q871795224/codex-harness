// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { AgentRunService } from '../../core/agent-runs/types'
import type { ProjectDocService } from '../../core/project-docs/types'
import { createNotificationStore } from '../../core/notifications/store'
import { createArchiveStore } from './archiveStore'
import { readProjectDocConfig } from './config'
import { startArchiveRun } from './archiveRun'

it('generates a Codex draft without creating a persistent Agent Run or writing the project document', async () => {
  const start = vi.fn()
  const generateArchive = vi.fn(async () => '  新进展  ')
  const writeSection = vi.fn()
  const persistDraft = vi.fn()
  const store = createArchiveStore()
  await startArchiveRun({
    store, persistDraft,
    agentRuns: { start } as unknown as AgentRunService,
    projectDocs: {
      read: vi.fn(async () => ({ content: '## Status\n旧进展', currentSeq: 4 })),
      generateArchive, writeSection,
    } as unknown as ProjectDocService,
  }, {
    instanceId: 'plugin', threadId: 'source', projectId: 'project', provider: 'codex', workspaceRoot: '/repo',
    items: [{ turnId: 'turn', item: { type: 'agentMessage', text: '已完成变更' } }],
    config: readProjectDocConfig({}),
  })
  expect(generateArchive).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: '/repo', prompt: expect.stringContaining('已完成变更') }))
  expect(start).not.toHaveBeenCalled()
  expect(writeSection).not.toHaveBeenCalled()
  expect(persistDraft).toHaveBeenCalledWith(expect.objectContaining({ statusDraft: '新进展', baseStatus: '旧进展', baseSeq: 4, threadId: 'source' }))
  expect(store.getState().notices.project.kind).toBe('pending')
})

it('records an archive failure against the originating conversation with raw errors only in details', async () => {
  const notifications = createNotificationStore({ load: async () => null, save: async () => undefined })
  const store = createArchiveStore()
  await startArchiveRun({
    notifications, store,
    agentRuns: {} as AgentRunService,
    projectDocs: { read: vi.fn(async () => { throw new Error('RAW_ARCHIVE_ERROR') }) } as unknown as ProjectDocService,
    persistDraft: vi.fn(),
  }, { instanceId: 'plugin', threadId: 'thread-a', projectId: 'project-a', provider: 'codex', workspaceRoot: '/repo', items: [], config: readProjectDocConfig({}) })
  expect(notifications.snapshot().records).toHaveLength(1)
  expect(notifications.snapshot().records[0]).toMatchObject({ level: 'error', title: '项目归档未完成', threadId: 'thread-a', workspaceRoot: '/repo' })
  expect(notifications.snapshot().records[0].details).toContain('RAW_ARCHIVE_ERROR')
  expect(store.getState().notices['project-a'].kind).toBe('failed')
})

it.each(['empty', 'failed'] as const)('does not persist a draft when ephemeral generation is %s', async (outcome) => {
  const persistDraft = vi.fn()
  const store = createArchiveStore()
  await startArchiveRun({
    store, persistDraft, agentRuns: {} as AgentRunService,
    projectDocs: {
      read: vi.fn(async () => ({ content: '', currentSeq: 1 })),
      generateArchive: vi.fn(async () => { if (outcome === 'failed') throw new Error('生成失败'); return '  ' }),
    } as unknown as ProjectDocService,
  }, {
    instanceId: 'plugin', threadId: 'source', projectId: 'project', provider: 'codex', workspaceRoot: '/repo',
    items: [{ turnId: 'turn', item: { type: 'agentMessage', text: '已完成变更' } }], config: readProjectDocConfig({}),
  })
  expect(persistDraft).not.toHaveBeenCalled()
  expect(store.getState().notices.project.kind).toBe('failed')
})

it('keeps Claude archive generation on its existing Agent Run path', async () => {
  const generateArchive = vi.fn()
  const start = vi.fn(async () => ({ runId: 'run' }))
  const persistDraft = vi.fn()
  const store = createArchiveStore()
  await startArchiveRun({
    store, persistDraft,
    agentRuns: {
      start, snapshot: () => [{ runId: 'run', status: 'completed' }], subscribe: () => () => {},
      loadResult: async () => 'Claude 草稿',
    } as unknown as AgentRunService,
    projectDocs: { read: async () => ({ content: '', currentSeq: 1 }), generateArchive } as unknown as ProjectDocService,
  }, {
    instanceId: 'plugin', threadId: 'claude:source', projectId: 'project', provider: 'claude', workspaceRoot: '/repo',
    items: [{ turnId: 'turn', item: { type: 'agentMessage', text: '已完成变更' } }], config: readProjectDocConfig({}),
  })
  expect(generateArchive).not.toHaveBeenCalled()
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', mode: 'detached', parentThreadId: 'claude:source' }))
  expect(persistDraft).toHaveBeenCalledWith(expect.objectContaining({ statusDraft: 'Claude 草稿' }))
})
