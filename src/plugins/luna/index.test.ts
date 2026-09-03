import { describe, expect, it, vi } from 'vitest'
import type { AgentRunService, StartAgentRunInput } from '../../core/agent-runs/types'
import type { PluginInstanceContext, QuickActionContribution } from '../../extensions/types'
import { LUNA_RUN_TITLE, lunaPlugin } from './index'

function captureQuickAction(): { ctx: PluginInstanceContext; registered: () => QuickActionContribution; start: ReturnType<typeof vi.fn> } {
  const start = vi.fn(async (input: StartAgentRunInput) => ({ ...input }) as never)
  let contribution: QuickActionContribution | null = null
  const agentRuns = { start } as unknown as AgentRunService
  const ctx = {
    pluginId: lunaPlugin.manifest.id,
    instanceId: 'builtin.temporary-agent:default',
    scope: { kind: 'global' as const },
    config: {},
    services: { get: <T,>() => agentRuns as T, provide: () => undefined, optional: () => undefined },
    events: { on: () => undefined, emit: () => undefined },
    slots: {
      threadHeaderActions: { register: () => undefined },
      newThreadPanels: { register: () => undefined },
      conversationTabs: { register: () => undefined },
      composerActions: { register: () => undefined },
      composerCompletions: { register: () => undefined },
      quickActions: { register: (c: QuickActionContribution) => { contribution = c } },
    },
    commands: { register: () => undefined },
    storage: { get: async () => null, set: async () => undefined },
    signal: new AbortController().signal,
    effect: () => undefined,
  } as unknown as PluginInstanceContext
  return { ctx, registered: () => { if (!contribution) throw new Error('未注册 quickAction'); return contribution }, start }
}

describe('Luna（路线 B 纳管）', () => {
  it('注册一个 delegated quickAction，由 harness 起独立子 Agent 而非模型自治 spawn', async () => {
    const { ctx, registered, start } = captureQuickAction()
    lunaPlugin.activate(ctx)
    const action = registered()
    expect(action.label).toBe('交给 Luna')

    await action.run({ threadId: 'parent-1', threadCwd: '/repo', workspaceRoot: '/repo', checkoutRoot: '/repo', provider: 'codex', disabled: false })

    expect(start).toHaveBeenCalledOnce()
    const input = start.mock.calls[0][0]
    expect(input.mode).toBe('delegated')
    expect(input.parentThreadId).toBe('parent-1')
    expect(input.title).toBe(LUNA_RUN_TITLE)
    expect(input.workspaceRoot).toBe('/repo')
  })

  it('没有会话或工作目录时拒绝启动', async () => {
    const { ctx, registered, start } = captureQuickAction()
    lunaPlugin.activate(ctx)
    const action = registered()
    await expect(action.run({ threadId: null, threadCwd: null, workspaceRoot: null, checkoutRoot: '/repo', disabled: false })).rejects.toThrow('会话')
    await expect(action.run({ threadId: 'p', threadCwd: '/repo', workspaceRoot: '/repo', checkoutRoot: null, disabled: false })).rejects.toThrow('工作目录')
    expect(start).not.toHaveBeenCalled()
  })
})
