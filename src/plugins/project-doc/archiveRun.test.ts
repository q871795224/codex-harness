// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { AgentRunService } from '../../core/agent-runs/types'
import type { ProjectDocService } from '../../core/project-docs/types'
import { createNotificationStore } from '../../core/notifications/store'
import { createArchiveStore } from './archiveStore'
import { readProjectDocConfig } from './config'
import { startArchiveRun } from './archiveRun'

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
