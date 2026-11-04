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

it.each(['codex', 'claude'] as const)('keeps compaction usable without legacy archive actions for %s', async (provider) => {
  const projectId = crypto.randomUUID()
  const docs = {
    threadProject: vi.fn(async () => projectId),
    measure: vi.fn(async () => ({ seq: 1, tokens: 12000 })),
  }
  const runs = { start: vi.fn() }
  const host = new PluginHost([projectDocPlugin], {
    storage: () => ({ get: async () => null, set: async () => {} }),
    services: { 'harness.projectDocs': docs, 'harness.agentRuns': runs, 'harness.notifications': {} },
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
    await screen.findByRole('button', { name: '整理并归档' })
    expect(docs.measure).toHaveBeenCalledWith(projectId)
    expect(runs.start).not.toHaveBeenCalled()
  } finally {
    await host.dispose()
  }
})
