import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunTransport, ThreadInspection } from './types'
import { AgentRunCoordinator } from './service'

class FakeTransport implements AgentRunTransport {
  runs: AgentRun[] = []
  startedPrompts: Array<{ threadId: string; prompt: string }> = []
  inspection: ThreadInspection = { active: true, lastTurnStatus: 'inProgress' }
  result = '子任务结论'

  async listRuns() { return this.runs }
  async saveRun(run: AgentRun) {
    const saved = { ...run, createdAt: run.createdAt || 1, updatedAt: run.updatedAt || 1 }
    this.runs = [saved, ...this.runs.filter((candidate) => candidate.runId !== run.runId)]
    return saved
  }
  async startThread() { return 'child-1' }
  async configureThread() {}
  async startTurn(threadId: string, prompt: string) {
    this.startedPrompts.push({ threadId, prompt })
    return `turn-${this.startedPrompts.length}`
  }
  async interruptTurn() {}
  async inspectThread() { return this.inspection }
  async readLastAgentMessage() { return this.result }
}

describe('AgentRunCoordinator', () => {
  it('creates a detached child thread without persisting the prompt', async () => {
    const transport = new FakeTransport()
    const service = new AgentRunCoordinator(transport, () => undefined)

    const run = await service.start({
      instanceId: 'temporary-agent',
      mode: 'detached',
      workspaceRoot: '/repo',
      prompt: '查询当前发布状态并总结',
    })

    expect(run.status).toBe('running')
    expect(run.childThreadId).toBe('child-1')
    expect(transport.startedPrompts).toEqual([{ threadId: 'child-1', prompt: '查询当前发布状态并总结' }])
    expect(JSON.stringify(transport.runs)).not.toContain('prompt')
  })

  it('configures the child thread before starting its turn', async () => {
    const calls: string[] = []
    const transport = new FakeTransport()
    transport.configureThread = async () => { calls.push('configure') }
    transport.startTurn = async () => { calls.push('turn'); return 'turn-1' }
    const service = new AgentRunCoordinator(transport, () => undefined)

    await service.start({
      instanceId: 'quick-agent',
      mode: 'detached',
      workspaceRoot: '/repo',
      prompt: '发布当前分支',
      settings: {
        model: 'gpt-5.6-luna',
        effort: 'max',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxMode: 'danger-full-access',
      },
    })

    expect(calls).toEqual(['configure', 'turn'])
  })

  it('tracks completion and returns delegated results to the parent once', async () => {
    const transport = new FakeTransport()
    const service = new AgentRunCoordinator(transport, () => undefined)
    const run = await service.start({
      instanceId: 'temporary-agent',
      mode: 'delegated',
      workspaceRoot: '/repo',
      parentThreadId: 'parent-1',
      prompt: '分析失败原因',
    })

    service.handleEvent({ method: 'turn/completed', params: { threadId: 'child-1', turn: { status: 'completed' } } })
    await waitFor(() => service.snapshot()[0].status === 'completed')
    await service.returnToParent(run.runId)
    await service.returnToParent(run.runId)

    expect(transport.startedPrompts).toHaveLength(2)
    expect(transport.startedPrompts[1].threadId).toBe('parent-1')
    expect(transport.startedPrompts[1].prompt).toContain('子任务结论')
    expect(service.snapshot()[0].returnedAt).not.toBeNull()
  })

  it('reconciles a finished run after restart', async () => {
    const transport = new FakeTransport()
    transport.runs = [makeRun({ status: 'running' })]
    transport.inspection = { active: false, lastTurnStatus: 'completed' }
    const service = new AgentRunCoordinator(transport, () => undefined)

    await service.initialize()

    expect(service.snapshot()[0].status).toBe('completed')
  })
})

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    instanceId: 'temporary-agent',
    mode: 'detached',
    status: 'running',
    title: '任务',
    workspaceRoot: '/repo',
    parentThreadId: null,
    childThreadId: 'child-1',
    turnId: 'turn-1',
    errorSummary: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    returnedAt: null,
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition not reached')
}
