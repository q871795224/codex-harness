// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginHost } from '../../core/plugins/runtime'
import { archiveStore } from './archiveStore'
import { projectDocDefaultInstance, projectDocPlugin } from './index'

afterEach(() => {
  cleanup()
  archiveStore.clearSelect()
})

it.each(['codex', 'claude'] as const)('compacts ephemerally without an Agent Run service or legacy archive actions for %s', async (provider) => {
  const projectId = crypto.randomUUID()
  const docs = {
    threadProject: vi.fn(async () => projectId),
    measure: vi.fn(async () => ({ seq: 1, tokens: 12000 })),
    beginCompaction: vi.fn(async () => ({ jobId: 'job', content: 'original', archivePath: '/archive' })),
    generateArchive: vi.fn(async () => 'new body'),
    completeCompaction: vi.fn(async () => ({ newSeq: 2, beforeTokens: 12000, afterTokens: 3000, archivePath: '/archive' })),
    cancelCompaction: vi.fn(async () => {}),
  }
  const host = new PluginHost([projectDocPlugin], {
    storage: () => ({ get: async () => null, set: async () => {} }),
    services: { 'harness.projectDocs': docs, 'harness.notifications': {} },
  })
  try {
    await host.syncInstances([projectDocDefaultInstance])
    expect(host.status(projectDocDefaultInstance.instanceId).phase).toBe('active')
    const context = { provider, threadId: crypto.randomUUID(), threadCwd: '/repo', workspaceRoot: '/repo', checkoutRoot: '/repo' }
    render(<>
      {host.resolvedComposerActions(context).map(({ contribution }) => (
        <div key={contribution.id}>{contribution.render({ ...context, disabled: false, items: [], insertSkillPrompt: async () => true })}</div>
      ))}
      {host.resolvedTurnActions(context).map(({ contribution }) => (
        <div key={contribution.id}>{contribution.render({ ...context, turnId: 'turn', disabled: false, items: [] })}</div>
      ))}
      {host.resolvedConversationBanners(context).map(({ contribution }) => (
        <div key={contribution.id}>{contribution.render(context)}</div>
      ))}
    </>)
    expect(screen.queryByRole('button', { name: '归档到项目' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '精简项目文档' }))
    const confirm = await screen.findByRole('button', { name: '整理并归档' })
    expect(docs.measure).toHaveBeenCalledWith(projectId)
    expect(docs.generateArchive).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    await screen.findByText('项目文档已整理')
    expect(docs.generateArchive).toHaveBeenCalledOnce()
    expect(docs.completeCompaction).toHaveBeenCalledWith(projectId, 'job', 'new body')
  } finally {
    await host.dispose()
  }
})
