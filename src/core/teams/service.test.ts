import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamCoordinator } from './service'
import { DEFAULT_TASK_LIMITS, emptyTeamState, type AgentMember, type AgentTeam, type TeamDependencies, type TeamDocument, type TeamState } from './types'
import type { AgentRun, AgentRunService, StartAgentRunInput } from '../agent-runs/types'
import { parseLeaderDecision } from './prompts'

const member = (id: string, access: AgentMember['access'] = 'isolated-delivery'): AgentMember => ({ id, name: id, description: id + ' 专长', instructions: id + ' 的职责', provider: 'codex', model: 'test-model', effort: 'low', skills: [], access, archived: false })
const leader = member('leader', 'read-only')
const worker = member('worker')
const reviewer = member('reviewer', 'read-only')
const team: AgentTeam = { id: 'team', name: '交付团队', leaderId: leader.id, memberIds: [leader.id, worker.id, reviewer.id], instructions: '先实现再审查', archived: false }
const controllers: TeamCoordinator[] = []

function fixture(initial?: TeamState) {
  let doc: TeamDocument = { revision: 0, content: JSON.stringify(initial ?? { ...emptyTeamState(), members: [leader, worker, reviewer], teams: [team] }) }
  const memory = new Map<string, TeamDocument>()
  const records: AgentRun[] = []
  const outputs = new Map<string, string>()
  const listeners = new Set<() => void>()
  const start = vi.fn(async (input: StartAgentRunInput): Promise<AgentRun> => {
    const id = input.runId ?? crypto.randomUUID()
    const run: AgentRun = { runId: id, instanceId: input.instanceId, provider: input.provider, mode: input.mode, workspaceAccess: input.workspaceAccess,
      status: 'running', title: input.title!, workspaceRoot: input.workspaceAccess === 'isolated-delivery' ? '/isolated/' + id : input.workspaceRoot,
      parentThreadId: input.parentThreadId ?? null, childThreadId: id, turnId: id, errorSummary: null, createdAt: Date.now(), updatedAt: Date.now(), completedAt: null, returnedAt: null, workspaceRemovedAt: null }
    records.push(run); listeners.forEach((l) => l()); return run
  })
  const cancel = vi.fn(async (id: string) => { records.find((r) => r.runId === id)!.status = 'cancelled'; listeners.forEach((l) => l()) })
  const runs = { initialize: async () => {}, snapshot: () => records, subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }, start, cancel, loadResult: async (id: string) => outputs.get(id) ?? '', openThread: vi.fn() } as unknown as AgentRunService
  const deps: TeamDependencies = {
    read: vi.fn(async (key) => structuredClone(key === 'state' ? doc : memory.get(key) ?? { revision: 0, content: '' })),
    write: vi.fn(async (key, revision, content) => {
      const old = key === 'state' ? doc : memory.get(key) ?? { revision: 0, content: '' }
      if (revision !== old.revision) throw new Error('文档已被其他窗口修改')
      const next = { revision: revision + 1, content }
      if (key === 'state') doc = next; else memory.set(key, next)
      return structuredClone(next)
    }),
    settings: async (m, readOnly) => ({ model: m.model, effort: m.effort, serviceTier: null, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxMode: readOnly ? 'read-only' : 'workspace-write' }),
    runs, skills: async () => [], models: async () => [],
  }
  const controller = new TeamCoordinator(deps); controllers.push(controller)
  const finish = (output = '完成：测试通过', status: AgentRun['status'] = 'completed') => {
    const run = records.at(-1)!; run.status = status; outputs.set(run.runId, output); listeners.forEach((l) => l())
  }
  return { controller, deps, records, start, cancel, finish, outputs, memory, state: () => JSON.parse(doc.content) as TeamState }
}
const decision = (action: string, memberId?: string) => '```harness-team\n' + JSON.stringify({ action, memberId, instruction: '实现目标并运行测试', reason: '按验收要求推进' }) + '\n```'
const flush = () => vi.advanceTimersByTimeAsync(2100)
async function create(f: ReturnType<typeof fixture>, target: 'team' | 'member' = 'team', maxRuns = 12) {
  await f.controller.initialize()
  return f.controller.createTask({ title: '登录功能', brief: '实现并审查登录，保证测试通过', workspaceRoot: '/repo', parentThreadId: 'origin', target: { kind: target, id: target === 'team' ? 'team' : 'worker' }, limits: { ...DEFAULT_TASK_LIMITS, maxRuns } })
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T00:00:00Z')) })
afterEach(() => { controllers.splice(0).forEach((c) => c.dispose()); vi.useRealTimers() })

describe('member and team collaboration', () => {
  it('direct assignment uses scoped memory and explicit identity, then waits for human acceptance', async () => {
    const f = fixture(); const id = await create(f, 'member', 1)
    f.memory.set('memory:worker', { revision: 1, content: '通用经验' })
    f.memory.set('memory:worker@/repo', { revision: 1, content: 'repo 特有经验' })
    f.memory.set('memory:worker@/elsewhere', { revision: 1, content: '不能泄漏的经验' })
    expect(f.start).not.toHaveBeenCalled()
    await f.controller.startTask(id); await flush()
    expect(f.start).toHaveBeenCalledTimes(1)
    const input = f.start.mock.calls[0][0]
    expect(input).toMatchObject({ parentThreadId: 'origin', workspaceAccess: 'isolated-delivery', settings: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' } })
    expect(input.prompt).toContain('worker 的职责'); expect(input.prompt).toContain('repo 特有经验'); expect(input.prompt).not.toContain('不能泄漏')
    f.finish(); await flush()
    expect(f.state().tasks[0].status).toBe('review')
    await f.controller.approveTask(id)
    expect(f.state().tasks[0].status).toBe('done')
  })
  it('leader dispatches sequentially, reviewers see the worktree, leader returns for human review', async () => {
    const f = fixture(); const id = await create(f)
    await f.controller.startTask(id); await flush()
    expect(f.start.mock.calls[0][0].workspaceAccess).toBe('read-only')
    expect(f.start.mock.calls[0][0].settings?.sandboxMode).toBe('read-only')
    f.finish(decision('delegate', 'worker')); await flush()
    expect(f.start.mock.calls[1][0].workspaceAccess).toBe('isolated-delivery')
    const checkout = f.records.at(-1)!.workspaceRoot
    f.finish('实现完成，测试通过'); await flush()
    expect(f.start.mock.calls[2][0].workspaceRoot).toBe(checkout)
    expect(f.start.mock.calls[2][0].prompt).toContain('实现完成，测试通过')
    f.finish(decision('delegate', 'reviewer')); await flush()
    expect(f.start.mock.calls[3][0]).toMatchObject({ workspaceRoot: checkout, workspaceAccess: 'read-only' })
    f.finish('审查通过'); await flush()
    f.finish(decision('review')); await flush()
    expect(f.state().tasks[0].status).toBe('review')
    expect(f.start).toHaveBeenCalledTimes(5)
  })
  it('validates member IDs and fails closed on malformed or unsolicited leader decisions', async () => {
    const f = fixture(); const id = await create(f)
    await f.controller.startTask(id); await flush()
    f.finish(decision('delegate', 'outside')); await flush()
    expect(f.state().tasks[0]).toMatchObject({ status: 'paused' })
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(() => parseLeaderDecision('普通文字', f.state().tasks[0])).toThrow('决策块')
    expect(() => parseLeaderDecision(decision('review'), f.state().tasks[0])).toThrow('尚无成员')
  })
  it('does not redispatch on repeated events or repeated start clicks', async () => {
    const f = fixture(); const id = await create(f)
    await f.controller.startTask(id); await flush()
    await expect(f.controller.startTask(id)).rejects.toThrow('已在运行')
    f.finish(decision('delegate', 'worker')); await flush(); await flush(); await flush()
    expect(f.start).toHaveBeenCalledTimes(2)
  })
  it('stops dispatch at the run budget, and resumes the pending decision after explicit extension', async () => {
    const f = fixture(); const id = await create(f, 'team', 1)
    await f.controller.startTask(id); await flush()
    f.finish(decision('delegate', 'worker')); await flush()
    expect(f.state().tasks[0].status).toBe('paused'); expect(f.start).toHaveBeenCalledTimes(1)
    await f.controller.extendLimits(id, { ...DEFAULT_TASK_LIMITS, maxRuns: 4 })
    await f.controller.startTask(id); await flush()
    expect(f.start).toHaveBeenCalledTimes(2)
  })
  it('enforces rework budget without dropping earlier evidence', async () => {
    const f = fixture(); const id = await create(f)
    await f.controller.extendLimits(id, { ...DEFAULT_TASK_LIMITS, maxReworks: 0 })
    await f.controller.startTask(id); await flush()
    f.finish(decision('delegate', 'worker')); await flush()
    f.finish(); await flush()
    f.finish(decision('delegate', 'worker')); await flush()
    expect(f.state().tasks[0].status).toBe('paused')
    expect(f.state().tasks[0].note).toContain('返工预算')
    expect(f.start).toHaveBeenCalledTimes(3)
  })
  it('deadline pauses scheduling and interrupts the current child', async () => {
    const f = fixture(); const id = await create(f)
    await f.controller.extendLimits(id, { ...DEFAULT_TASK_LIMITS, maxMinutes: 1 })
    await f.controller.startTask(id); await flush()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.state().tasks[0].status).toBe('paused'); expect(f.cancel).toHaveBeenCalledTimes(1)
    await expect(f.controller.startTask(id)).rejects.toThrow('时间预算')
  })
  it('pause and stop cancel active children and do not discard their worktrees', async () => {
    const f = fixture(); const id = await create(f, 'member')
    await f.controller.startTask(id); await flush()
    await f.controller.pauseTask(id); await flush()
    expect(f.state().tasks[0].status).toBe('paused')
    expect(f.state().tasks[0].executionRoot).toContain('/isolated/')
    await f.controller.stopTask(id)
    expect(f.state().tasks[0].status).toBe('stopped')
    expect(f.cancel).toHaveBeenCalledTimes(1)
  })
  it('new instance never automatically takes ownership after restart', async () => {
    const f = fixture(); const id = await create(f)
    await f.controller.startTask(id); await flush(); f.controller.dispose()
    const next = new TeamCoordinator(f.deps); controllers.push(next); await next.initialize()
    f.finish(decision('delegate', 'worker')); await flush()
    expect(f.start).toHaveBeenCalledTimes(1)
    await next.startTask(id); await flush()
    expect(f.start).toHaveBeenCalledTimes(2)
  })
  it('configuration changes do not mutate a task snapshot, archive blocks new assignments', async () => {
    const f = fixture(); const id = await create(f, 'member')
    await f.controller.saveMember({ ...worker, instructions: 'new instructions', archived: true })
    await expect(create(f, 'member')).rejects.toThrow('已归档')
    await f.controller.startTask(id); await flush()
    expect(f.start.mock.calls[0][0].prompt).toContain('worker 的职责')
  })
  it('a persistence failure prevents model dispatch', async () => {
    const f = fixture(); const id = await create(f)
    vi.mocked(f.deps.write).mockRejectedValueOnce(new Error('disk full'))
    await expect(f.controller.startTask(id)).rejects.toThrow('disk full')
    await flush(); expect(f.start).not.toHaveBeenCalled()
  })
  it('empty completed output pauses and an explicit retry can start a new run', async () => {
    const f = fixture(); const id = await create(f, 'member')
    await f.controller.startTask(id); await flush()
    f.finish(''); await flush()
    expect(f.state().tasks[0]).toMatchObject({ status: 'paused' })
    await f.controller.startTask(id); await flush()
    expect(f.start).toHaveBeenCalledTimes(2)
  })
  it('failure saving a started run cancels it even if storage remains unavailable', async () => {
    const f = fixture(); const id = await create(f, 'member')
    const start = f.start.getMockImplementation()!
    f.start.mockImplementationOnce(async (input) => {
      const run = await start(input)
      vi.mocked(f.deps.write).mockRejectedValue(new Error('disk full'))
      vi.mocked(f.deps.read).mockRejectedValue(new Error('disk unavailable'))
      return run
    })
    await f.controller.startTask(id); await flush()
    expect(f.cancel).toHaveBeenCalledWith(f.records[0].runId)
    expect(f.start).toHaveBeenCalledTimes(1)
  })
  it('concurrent windows can only claim one dispatch', async () => {
    const f = fixture(); const id = await create(f)
    const next = new TeamCoordinator(f.deps); controllers.push(next); await next.initialize()
    await Promise.allSettled([f.controller.startTask(id), next.startTask(id)])
    await flush(); expect(f.start).toHaveBeenCalledTimes(1)
  })
  it('memory conflicts preserve unsaved edits and workspace scopes remain separate', async () => {
    const f = fixture(); await f.controller.saveMemory('worker', 0, 'first', '/repo')
    await expect(f.controller.saveMemory('worker', 0, 'lost edit', '/repo')).rejects.toThrow('其他窗口')
    expect((await f.controller.readMemory('worker', '/repo')).content).toBe('first')
    expect((await f.controller.readMemory('worker', '/other')).content).toBe('')
  })
})

it('explicit resume after pause retries once and accounts for rework once', async () => {
  const f = fixture(); const id = await create(f, 'member')
  await f.controller.startTask(id); await flush()
  await f.controller.pauseTask(id); await flush()
  await f.controller.startTask(id); await flush()
  expect(f.start).toHaveBeenCalledTimes(2)
  expect(f.state().tasks[0].reworks).toBe(1)
  f.finish(); await flush()
  await f.controller.reworkTask(id, '补充失败分支测试')
  await f.controller.startTask(id); await flush()
  expect(f.start).toHaveBeenCalledTimes(3)
  expect(f.state().tasks[0].reworks).toBe(2)
  expect(f.start.mock.calls[2][0].prompt).toContain('补充失败分支测试')
})
it('an invalid decision is consumed and a human can ask the leader to retry', async () => {
  const f = fixture(); const id = await create(f)
  await f.controller.startTask(id); await flush()
  f.finish('I will do something'); await flush()
  expect(f.state().tasks[0].status).toBe('paused')
  await f.controller.startTask(id); await flush()
  expect(f.start).toHaveBeenCalledTimes(2)
  expect(f.start.mock.calls[1][0].workspaceAccess).toBe('read-only')
})
it('late startup after a stop in another window is cancelled and cannot overwrite the stop', async () => {
  const f = fixture(); const id = await create(f, 'member')
  const originalStart = f.start.getMockImplementation()!
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  f.start.mockImplementationOnce(async (input) => { await gate; return originalStart(input) })
  await f.controller.startTask(id)
  // Let the dispatch persist its intent and enter the blocked transport call.
  await vi.advanceTimersByTimeAsync(1)
  const other = new TeamCoordinator(f.deps); controllers.push(other); await other.initialize()
  await other.stopTask(id)
  release(); await flush()
  expect(f.state().tasks[0].status).toBe('stopped')
  expect(f.cancel).toHaveBeenCalledTimes(1)
  expect(f.state().tasks[0].steps[0].runId).toBeTruthy()
})
