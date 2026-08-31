import { describe, expect, it, vi } from 'vitest'
import type { AgentRunService } from '../../core/agent-runs/types'
import { PluginHost } from '../../core/plugins/runtime'
import { DEFAULT_QUICK_AGENT_JOB } from './config'
import { quickAgentDefaultInstance, quickAgentPlugin } from './index'

describe('quick agent plugin', () => {
  it('starts returnable jobs as delegated runs bound to the source thread', async () => {
    const start = vi.fn(async () => undefined)
    const host = new PluginHost([quickAgentPlugin], {
      storage: () => ({ async get<T>() { return null as T | null }, async set() {} }),
      services: { 'harness.agentRuns': { start } as unknown as AgentRunService },
    })
    await host.syncInstances([{
      ...quickAgentDefaultInstance,
      config: { jobs: [{ ...DEFAULT_QUICK_AGENT_JOB, completion: 'return-to-parent' }] },
    }])
    const [action] = host.resolvedQuickActions({ threadId: 'parent-1', threadCwd: '/repo', workspaceRoot: '/repo' })

    await action.contribution.run({
      threadId: 'parent-1',
      threadCwd: '/repo',
      workspaceRoot: '/repo',
      checkoutRoot: '/repo',
      disabled: false,
    })

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'delegated',
      parentThreadId: 'parent-1',
    }))
  })

  it('does not start a returnable job outside a conversation', async () => {
    const start = vi.fn(async () => undefined)
    const host = new PluginHost([quickAgentPlugin], {
      storage: () => ({ async get<T>() { return null as T | null }, async set() {} }),
      services: { 'harness.agentRuns': { start } as unknown as AgentRunService },
    })
    await host.syncInstances([{
      ...quickAgentDefaultInstance,
      config: { jobs: [{ ...DEFAULT_QUICK_AGENT_JOB, completion: 'return-to-parent' }] },
    }])
    const [action] = host.resolvedQuickActions({ threadId: null, threadCwd: null, workspaceRoot: '/repo' })

    await expect(action.contribution.run({
      threadId: null,
      threadCwd: null,
      workspaceRoot: '/repo',
      checkoutRoot: '/repo',
      disabled: false,
    })).rejects.toThrow('需要从会话中启动')
    expect(start).not.toHaveBeenCalled()
  })
})
