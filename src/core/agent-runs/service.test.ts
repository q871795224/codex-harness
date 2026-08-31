import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunTransport, ThreadInspection } from './types'
import { AgentRunCoordinator, isolatedAgentBranch } from './service'

class FakeTransport implements AgentRunTransport {
  runs: AgentRun[] = []
  startedPrompts: Array<{ threadId: string; prompt: string }> = []
  startedWorkspaces: string[] = []
  inspection: ThreadInspection = { active: true, lastTurnStatus: 'inProgress' }
  result = '子任务结论'

  async listRuns() { return this.runs }
  async saveRun(run: AgentRun) {
    const saved = { ...run, createdAt: run.createdAt || 1, updatedAt: run.updatedAt || 1 }
    this.runs = [saved, ...this.runs.filter((candidate) => candidate.runId !== run.runId)]
    return saved
  }
  async prepareWorkspace(workspaceRoot: string, _access: AgentRun['workspaceAccess'], _runId: string) { return workspaceRoot }
  async startThread(workspaceRoot: string) { this.startedWorkspaces.push(workspaceRoot); return 'child-1' }
  async configureThread() {}
  async startTurn(threadId: string, prompt: string) {
    this.startedPrompts.push({ threadId, prompt })
    return `turn-${this.startedPrompts.length}`
  }
  async interruptTurn() {}
  async inspectThread() { return this.inspection }
  async readLastAgentMessage() { return this.result }
  async openWorkspace(_workspaceRoot: string) {}
  async deliveryContext(_workspaceRoot: string) { return { branch: 'codex-harness/test', remoteUrl: null, reviewUrl: null, reviewLabel: null } }
  async removeWorkspace(_workspaceRoot: string, _runId: string) {}
}

describe('AgentRunCoordinator', () => {
  it('creates a detached child thread without persisting the prompt', async () => {
    const transport = new FakeTransport()
    const service = new AgentRunCoordinator(transport, () => undefined)

    const run = await service.start({
      instanceId: 'temporary-agent',
      mode: 'detached',
      workspaceAccess: 'shared-write',
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
      workspaceAccess: 'shared-write',
      workspaceRoot: '/repo',
      prompt: '发布当前分支',
      settings: {
        model: 'gpt-5.6-luna',
        effort: 'max',
        serviceTier: null,
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
      workspaceAccess: 'read-only',
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

  it('blocks two shared writers in the same checkout but permits read-only work', async () => {
    const transport = new FakeTransport()
    const service = new AgentRunCoordinator(transport, () => undefined)
    await service.start({ instanceId: 'writer', mode: 'detached', workspaceAccess: 'shared-write', workspaceRoot: '/repo', prompt: '修改代码' })

    await expect(service.start({ instanceId: 'writer-2', mode: 'detached', workspaceAccess: 'shared-write', workspaceRoot: '/repo', prompt: '也修改代码' }))
      .rejects.toThrow('正在写入同一工作目录')
    await expect(service.start({ instanceId: 'reader', mode: 'detached', workspaceAccess: 'read-only', workspaceRoot: '/repo', prompt: '只检查代码' }))
      .resolves.toMatchObject({ status: 'running', workspaceAccess: 'read-only' })
  })

  it('reserves the checkout while a shared writer is starting', async () => {
    const transport = new FakeTransport()
    let releaseWorkspace!: () => void
    transport.prepareWorkspace = (workspaceRoot) => new Promise((resolve) => {
      releaseWorkspace = () => resolve(workspaceRoot)
    })
    const service = new AgentRunCoordinator(transport, () => undefined)

    const first = service.start({ instanceId: 'writer', mode: 'detached', workspaceAccess: 'shared-write', workspaceRoot: '/repo', prompt: '修改代码' })
    await Promise.resolve()
    await expect(service.start({ instanceId: 'writer-2', mode: 'detached', workspaceAccess: 'shared-write', workspaceRoot: '/repo', prompt: '同时修改' }))
      .rejects.toThrow('正在写入同一工作目录')
    releaseWorkspace()
    await expect(first).resolves.toMatchObject({ status: 'running' })
  })

  it('prepares a separate workspace for isolated delivery', async () => {
    const transport = new FakeTransport()
    transport.prepareWorkspace = async (_workspaceRoot, access) => access === 'isolated-delivery' ? '/repo-isolated' : '/repo'
    const service = new AgentRunCoordinator(transport, () => undefined)

    const run = await service.start({ instanceId: 'delivery', mode: 'detached', workspaceAccess: 'isolated-delivery', workspaceRoot: '/repo', prompt: '交付改动' })
    expect(run.workspaceRoot).toBe('/repo-isolated')
    expect(transport.startedWorkspaces).toEqual(['/repo-isolated'])
  })

  it('opens, describes, and removes a completed isolated workspace', async () => {
    const transport = new FakeTransport()
    const calls: string[] = []
    transport.openWorkspace = async (workspaceRoot) => { calls.push(`open:${workspaceRoot}`) }
    transport.removeWorkspace = async (workspaceRoot, runId) => { calls.push(`remove:${workspaceRoot}:${runId}`) }
    transport.runs = [makeRun({ runId: 'isolated-1', workspaceAccess: 'isolated-delivery', workspaceRoot: '/repo-isolated', status: 'completed', completedAt: 10 })]
    const service = new AgentRunCoordinator(transport, () => undefined)

    await service.openWorkspace('isolated-1')
    await expect(service.deliveryContext('isolated-1')).resolves.toMatchObject({ branch: 'codex-harness/test' })
    await service.removeWorkspace('isolated-1')

    expect(calls).toEqual(['open:/repo-isolated', 'remove:/repo-isolated:isolated-1'])
    expect(service.snapshot()[0].workspaceRemovedAt).not.toBeNull()
    await expect(service.openWorkspace('isolated-1')).rejects.toThrow('已清理')
    await expect(service.deliveryContext('isolated-1')).resolves.toMatchObject({ branch: 'codex-harness/isolated' })
  })

  it('uses the same stable branch name as the native worktree creator', () => {
    expect(isolatedAgentBranch('12345678-1234-1234-1234-123456789abc')).toBe('codex-harness/12345678')
  })

  it('does not remove a running isolated workspace', async () => {
    const transport = new FakeTransport()
    transport.runs = [makeRun({ workspaceAccess: 'isolated-delivery' })]
    const service = new AgentRunCoordinator(transport, () => undefined)

    await expect(service.removeWorkspace('run-1')).rejects.toThrow('仍在运行')
  })
})

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    instanceId: 'temporary-agent',
    mode: 'detached',
    workspaceAccess: 'shared-write',
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
    workspaceRemovedAt: null,
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
