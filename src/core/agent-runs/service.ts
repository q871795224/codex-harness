import type { AppServerEvent, JsonObject } from '../domain/codex'
import type { AgentRun, AgentRunService, AgentRunTransport, StartAgentRunInput } from './types'

export class AgentRunCoordinator implements AgentRunService {
  private runs: AgentRun[] = []
  private readonly listeners = new Set<() => void>()
  private initializePromise: Promise<void> | null = null

  constructor(
    private readonly transport: AgentRunTransport,
    private readonly selectThread: (threadId: string) => void,
  ) {}

  initialize(): Promise<void> {
    if (!this.initializePromise) this.initializePromise = this.loadAndReconcile()
    return this.initializePromise
  }

  snapshot = (): AgentRun[] => this.runs

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(input: StartAgentRunInput): Promise<AgentRun> {
    await this.initialize()
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('任务内容不能为空')
    if (!input.workspaceRoot) throw new Error('任务必须指定 workspace')
    if (input.mode === 'delegated' && !input.parentThreadId) throw new Error('委派任务必须指定父会话')

    let run = await this.persist({
      runId: crypto.randomUUID(),
      instanceId: input.instanceId,
      mode: input.mode,
      status: 'starting',
      title: runTitle(prompt),
      workspaceRoot: input.workspaceRoot,
      parentThreadId: input.parentThreadId ?? null,
      childThreadId: null,
      turnId: null,
      errorSummary: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      returnedAt: null,
    })

    try {
      const childThreadId = await this.transport.startThread(input.workspaceRoot)
      run = await this.persist({ ...run, childThreadId, updatedAt: Date.now() })
      const turnId = await this.transport.startTurn(childThreadId, prompt)
      return await this.persist({ ...run, turnId, status: 'running', updatedAt: Date.now() })
    } catch (error) {
      await this.persist({
        ...run,
        status: 'failed',
        errorSummary: messageOf(error),
        completedAt: Date.now(),
        updatedAt: Date.now(),
      })
      throw error
    }
  }

  async cancel(runId: string): Promise<void> {
    await this.initialize()
    const run = this.requireRun(runId)
    if (!run.childThreadId || !run.turnId || !isRunning(run)) return
    await this.transport.interruptTurn(run.childThreadId, run.turnId)
    await this.persist({ ...run, status: 'cancelled', completedAt: Date.now(), updatedAt: Date.now() })
  }

  async loadResult(runId: string): Promise<string> {
    await this.initialize()
    const run = this.requireRun(runId)
    if (!run.childThreadId) throw new Error('任务还没有 child thread')
    return this.transport.readLastAgentMessage(run.childThreadId)
  }

  async returnToParent(runId: string): Promise<void> {
    await this.initialize()
    const run = this.requireRun(runId)
    if (run.mode !== 'delegated' || !run.parentThreadId) throw new Error('该任务没有父会话')
    if (run.status !== 'completed') throw new Error('任务尚未完成')
    if (run.returnedAt) return
    const result = await this.loadResult(runId)
    await this.transport.startTurn(run.parentThreadId, [
      `以下是临时子 Agent「${run.title}」的执行结果：`,
      '',
      result,
      '',
      '请结合当前主会话目标继续处理。',
    ].join('\n'))
    await this.persist({ ...run, returnedAt: Date.now(), updatedAt: Date.now() })
  }

  openThread(threadId: string): void {
    this.selectThread(threadId)
  }

  handleEvent(event: AppServerEvent): void {
    const params = event.params ?? {}
    const threadId = eventThreadId(params)
    if (!threadId) return
    const run = this.runs.find((candidate) => candidate.childThreadId === threadId)
    if (!run) return

    if (event.id !== undefined && isApprovalRequest(event.method ?? '')) {
      void this.persist({ ...run, status: 'waitingApproval', updatedAt: Date.now() })
      return
    }
    if (event.method === 'serverRequest/resolved' && run.status === 'waitingApproval') {
      void this.persist({ ...run, status: 'running', updatedAt: Date.now() })
      return
    }
    if (event.method !== 'turn/completed') return
    const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined
    const status = turn?.status === 'completed' ? 'completed'
      : turn?.status === 'interrupted' ? 'cancelled'
        : 'failed'
    void this.persist({
      ...run,
      status,
      errorSummary: status === 'failed' ? turn?.error?.message ?? '子 Agent 执行失败' : null,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  private async loadAndReconcile(): Promise<void> {
    this.runs = await this.transport.listRuns()
    this.emit()
    await Promise.all(this.runs.filter(isRunning).map(async (run) => {
      if (!run.childThreadId) {
        await this.persist({ ...run, status: 'failed', errorSummary: '任务没有 child thread', completedAt: Date.now(), updatedAt: Date.now() })
        return
      }
      try {
        const inspection = await this.transport.inspectThread(run.childThreadId)
        if (inspection.active || inspection.lastTurnStatus === 'inProgress') return
        const status = inspection.lastTurnStatus === 'completed' ? 'completed'
          : inspection.lastTurnStatus === 'interrupted' ? 'cancelled'
            : 'failed'
        await this.persist({
          ...run,
          status,
          errorSummary: status === 'failed' ? 'Harness 重启后发现子任务未成功完成' : null,
          completedAt: Date.now(),
          updatedAt: Date.now(),
        })
      } catch (error) {
        await this.persist({ ...run, status: 'failed', errorSummary: messageOf(error), completedAt: Date.now(), updatedAt: Date.now() })
      }
    }))
  }

  private requireRun(runId: string): AgentRun {
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (!run) throw new Error(`找不到任务：${runId}`)
    return run
  }

  private async persist(run: AgentRun): Promise<AgentRun> {
    const saved = await this.transport.saveRun(run)
    this.runs = [saved, ...this.runs.filter((candidate) => candidate.runId !== saved.runId)]
    this.emit()
    return saved
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function isRunning(run: AgentRun): boolean {
  return run.status === 'starting' || run.status === 'running' || run.status === 'waitingApproval'
}

function eventThreadId(params: JsonObject): string | null {
  const value = params.threadId ?? params.conversationId
  return typeof value === 'string' ? value : null
}

function isApprovalRequest(method: string): boolean {
  return method === 'execCommandApproval'
    || method === 'applyPatchApproval'
    || method.endsWith('/requestApproval')
    || method === 'item/tool/requestUserInput'
}

function runTitle(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').slice(0, 80)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
