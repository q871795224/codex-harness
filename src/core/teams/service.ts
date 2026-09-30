import { activeRun, emptyTeamState, type AgentMember, type AgentTeam, type CreateTeamTask, type TaskLimits, type TeamDependencies, type TeamDocument, type TeamSnapshot, type TeamState, type TeamStep, type TeamTask, type TeamsService } from './types'
import { memberPrompt, parseLeaderDecision, parseState, validateLimits, validateMember } from './prompts'

const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const clone = <T,>(value: T): T => structuredClone(value)

export class TeamCoordinator implements TeamsService {
  readonly runs
  private value: TeamSnapshot = { state: emptyTeamState(), loading: true, error: null }
  private revision = 0
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private ready: Promise<void> | null = null
  private owner = crypto.randomUUID()
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private ticking = false
  private disposed = false
  private now: () => number

  constructor(private deps: TeamDependencies) { this.runs = deps.runs; this.now = deps.now ?? Date.now }
  snapshot = () => this.value
  isCoordinating = (id: string) => !this.disposed && this.value.state.tasks.some((task) => task.id === id && task.status === 'running' && task.owner === this.owner)
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { for (const listener of this.listeners) listener() }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn)
    this.queue = job.catch(() => undefined)
    return job
  }
  private async load() {
    const document = await this.deps.read('state')
    if (!this.value.loading && !this.value.error && document.revision === this.revision) return
    this.revision = document.revision
    this.value = { state: document.content ? parseState(document.content) : emptyTeamState(), loading: false, error: null }
    this.emit()
  }
  private async save(state: TeamState) {
    const result = await this.deps.write('state', this.revision, JSON.stringify(state))
    this.revision = result.revision
    this.value = { state, loading: false, error: null }
    this.emit()
  }
  initialize(): Promise<void> {
    if (!this.ready) this.ready = this.serial(async () => {
      await this.runs.initialize()
      await this.load()
      if (this.disposed) return
      this.unsubscribe = this.runs.subscribe(() => this.schedule())
      this.timer = setInterval(() => this.schedule(), 2000)
      // Ownership is deliberately not inherited on restart. User resumes explicitly.
    }).catch((e) => { this.ready = null; this.fail(e); throw e })
    return this.ready
  }
  dispose() {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
  }
  private fail(e: unknown) { this.value = { ...this.value, loading: false, error: message(e) }; this.emit() }
  refresh = async () => { await this.initialize(); await this.runs.refresh?.(); await this.serial(() => this.load()) }
  private async change(fn: (state: TeamState) => void) {
    await this.initialize()
    await this.serial(async () => { await this.load(); const state = clone(this.value.state); fn(state); await this.save(state) })
    this.schedule()
  }
  saveMember = async (member: AgentMember) => {
    validateMember(member)
    await this.change((state) => {
      if (state.members.some((m) => m.id !== member.id && m.name.trim().toLowerCase() === member.name.trim().toLowerCase())) throw new Error('成员名称已存在')
      const index = state.members.findIndex((m) => m.id === member.id)
      const next = { ...clone(member), name: member.name.trim() }
      if (index < 0) state.members.push(next); else state.members[index] = next
    })
  }
  saveTeam = async (team: AgentTeam) => {
    await this.change((state) => {
      if (!team.name.trim()) throw new Error('请填写团队名称')
      const memberIds = [...new Set([team.leaderId, ...team.memberIds])]
      if (memberIds.length < 2 || memberIds.some((id) => !state.members.some((m) => m.id === id && !m.archived))) throw new Error('团队需要一名队长和至少一名可用成员')
      const index = state.teams.findIndex((t) => t.id === team.id)
      const next = { ...clone(team), name: team.name.trim(), memberIds }
      if (index < 0) state.teams.push(next); else state.teams[index] = next
    })
  }
  createTask = async (input: CreateTeamTask) => {
    validateLimits(input.limits)
    if (!input.title.trim() || !input.brief.trim() || !input.workspaceRoot.trim()) throw new Error('请填写任务标题、完整说明和工作区')
    const id = crypto.randomUUID()
    await this.change((state) => {
      const team = input.target.kind === 'team' ? state.teams.find((t) => t.id === input.target.id && !t.archived) : null
      const ids = input.target.kind === 'team' ? team?.memberIds : [input.target.id]
      if (!ids?.length) throw new Error('负责人不存在')
      const members = ids.map((id) => state.members.find((m) => m.id === id && !m.archived))
      if (members.some((m) => !m)) throw new Error('任务包含已归档或不存在的成员')
      state.tasks.unshift({ ...clone(input), id, members: clone(members as AgentMember[]), team: clone(team ?? null),
        status: 'draft', owner: null, reworks: 0, steps: [], note: '', createdAt: this.now(), updatedAt: this.now(), deadline: null, executionRoot: null })
    })
    return id
  }
  private task(state: TeamState, id: string) {
    const task = state.tasks.find((t) => t.id === id)
    if (!task) throw new Error('任务不存在')
    return task
  }
  private runFor(step: TeamStep) { return this.runs.snapshot().find((r) => r.runId === step.id) }
  private async updateTask(task: TeamTask) {
    const state = clone(this.value.state)
    state.tasks[state.tasks.findIndex((t) => t.id === task.id)] = { ...task, updatedAt: this.now() }
    await this.save(state)
  }
  startTask = async (id: string) => {
    await this.runs.refresh?.()
    await this.change((state) => {
      const task = this.task(state, id)
      if (!['draft', 'paused', 'running'].includes(task.status)) throw new Error('只能启动待执行或已暂停的任务')
      if (task.status === 'running' && task.owner === this.owner) throw new Error('任务已在运行')
      const step = task.steps.at(-1)
      const run = step && this.runFor(step)
      if (run && activeRun(run)) throw new Error('已有成员仍在执行，请先暂停并等待停止，再接管任务')
      // AgentRun persists before any model request. A missing run after an explicit
      // refresh is an abandoned intent; the old owner is fenced by beforeStart.
      if (step && !step.consumed && !run) step.consumed = true
      if (step && run && ['failed', 'cancelled'].includes(run.status)) step.consumed = true
      if (task.steps.length >= task.limits.maxRuns && (!step || step.consumed || run?.status !== 'completed')) throw new Error('执行次数已达上限，请先增加预算')
      if (task.deadline && this.now() >= task.deadline) throw new Error('时间预算已耗尽，请先增加预算')
      task.status = 'running'; task.owner = this.owner; task.note = ''
      task.deadline ??= this.now() + task.limits.maxMinutes * 60_000
    })
  }
  private async halt(id: string, stopped: boolean) {
    await this.runs.refresh?.()
    await this.change((state) => {
      const task = this.task(state, id)
      if (task.status === 'done') throw new Error('已验收任务不能停止')
      task.status = stopped ? 'stopped' : 'paused'; task.owner = null
      task.note = stopped ? '用户停止了任务；工作区和执行记录保留。' : '用户暂停了调度，正在停止活动执行。'
    })
    const task = this.task(this.value.state, id)
    for (const step of task.steps) {
      const run = this.runFor(step)
      if (run && activeRun(run)) await this.runs.cancel(run.runId)
    }
  }
  pauseTask = (id: string) => this.halt(id, false)
  stopTask = (id: string) => this.halt(id, true)
  approveTask = (id: string) => this.change((state) => {
    const task = this.task(state, id)
    if (task.status !== 'review') throw new Error('任务尚未提交验收')
    task.status = 'done'; task.owner = null; task.note = '用户已验收'
  })
  reworkTask = (id: string, feedback: string) => this.change((state) => {
    const task = this.task(state, id)
    if (task.status !== 'review' || !feedback.trim()) throw new Error('请在待验收任务中填写返工意见')
    if (task.reworks >= task.limits.maxReworks) throw new Error('返工次数已达上限，请先增加预算')
    task.brief += '\n\n## 用户返工意见\n' + feedback.trim()
    task.status = 'draft'; task.owner = null; task.note = '返工意见已保存，点击启动继续'
  })
  extendLimits = (id: string, limits: TaskLimits) => {
    validateLimits(limits)
    return this.change((state) => {
      const task = this.task(state, id)
      if (task.status === 'running' || task.status === 'done') throw new Error('请先暂停任务再修改预算')
      if (limits.maxRuns <= task.steps.length || limits.maxReworks < task.reworks) throw new Error('预算不能少于已执行次数')
      task.limits = clone(limits); task.deadline = this.now() + limits.maxMinutes * 60_000
    })
  }
  readMemory = (memberId: string, workspaceRoot?: string) => this.deps.read(`memory:${memberId}${workspaceRoot ? '@' + workspaceRoot : ''}`)
  saveMemory = async (memberId: string, revision: number, text: string, workspaceRoot?: string): Promise<TeamDocument> => {
    if (text.length > 32_000) throw new Error('成员记忆最多 32000 字，请整理后再保存')
    return this.deps.write(`memory:${memberId}${workspaceRoot ? '@' + workspaceRoot : ''}`, revision, text)
  }
  result = (step: TeamStep) => {
    const run = this.runFor(step)
    if (!run) return Promise.reject(new Error('尚无执行记录'))
    return this.runs.loadResult(run.runId)
  }
  models = () => this.deps.models()
  skills = (cwd: string) => this.deps.skills(cwd)

  private schedule() {
    if (this.ticking || this.disposed) return
    this.ticking = true
    void this.serial(async () => {
      await this.load()
      for (const current of this.value.state.tasks) {
        if (this.disposed) break
        if (current.status !== 'running' || current.owner !== this.owner) continue
        const task = clone(this.task(this.value.state, current.id))
        try { await this.advance(task) }
        catch (e) {
          // A conflicting window wins. Never overwrite its newer state or dispatch again.
          await this.load()
          const latest = clone(this.task(this.value.state, task.id))
          if (latest.owner === this.owner && latest.status === 'running') {
            latest.status = 'paused'; latest.note = message(e); latest.owner = null
            const pending = latest.steps.at(-1)
            if (pending && !this.runFor(pending)) pending.consumed = true
            await this.updateTask(latest)
            this.deps.notify?.('团队任务已暂停', latest.note)
          }
        }
      }
    }).catch((e) => this.fail(e)).finally(() => { this.ticking = false })
  }
  private async advance(task: TeamTask) {
    const last = task.steps.at(-1)
    const run = last && this.runFor(last)
    if (task.deadline && this.now() >= task.deadline) {
      task.status = 'paused'; task.owner = null; task.note = '时间预算已耗尽，调度已暂停'
      await this.updateTask(task)
      if (run && activeRun(run)) await this.runs.cancel(run.runId)
      this.deps.notify?.('团队任务已暂停', task.note)
      return
    }
    if (last && !last.consumed) {
      if (!run) throw new Error('上次启动未留下可确认的运行记录；请检查执行记录后重试，未自动重复派发')
      if (activeRun(run)) return
      last.runId = run.runId
      if (last.role === 'worker' && run.workspaceAccess === 'isolated-delivery') task.executionRoot = run.workspaceRoot
      if (run.status !== 'completed') {
        last.consumed = true
        task.status = 'paused'; task.owner = null; task.note = `执行${run.status === 'cancelled' ? '已停止' : '失败'}：${run.errorSummary ?? '查看会话后可以继续任务'}`
        await this.updateTask(task)
        return
      }
      const output = await this.runs.loadResult(run.runId)
      last.consumed = true
      if (!output.trim()) {
        task.status = 'paused'; task.owner = null; task.note = '执行结束但没有可验收的结果，请查看会话后再继续'
        await this.updateTask(task)
        return
      }
      if (last.role === 'leader') {
        let decision
        try { decision = parseLeaderDecision(output, task) }
        catch (e) {
          task.status = 'paused'; task.owner = null; task.note = message(e)
          await this.updateTask(task)
          this.deps.notify?.('队长决策需要检查', task.note)
          return
        }
        task.note = decision.reason
        if (decision.action !== 'delegate') {
          task.status = decision.action === 'review' ? 'review' : 'paused'; task.owner = null
          await this.updateTask(task)
          this.deps.notify?.(task.status === 'review' ? '团队任务等待验收' : '团队任务遇到阻塞', task.title)
          return
        }
        const member = task.members.find((m) => m.id === decision.memberId)!
        await this.dispatch(task, member, 'worker', decision.instruction!)
        return
      }
      if (!task.team) {
        task.status = 'review'; task.owner = null; task.note = '成员已完成，等待用户验收'
        await this.updateTask(task); this.deps.notify?.('成员任务等待验收', task.title); return
      }
    }
    const member = task.team ? task.members.find((m) => m.id === task.team!.leaderId)! : task.members[0]
    await this.dispatch(task, member, task.team ? 'leader' : 'worker', task.team ? '根据任务与已有执行结果决定下一步。' : task.brief)
  }
  private async dispatch(task: TeamTask, member: AgentMember, role: TeamStep['role'], instruction: string) {
    if (this.disposed) return
    if (task.steps.length >= task.limits.maxRuns) throw new Error('执行次数预算已耗尽，请增加预算后继续')
    const repeated = role === 'worker' && task.steps.some((step) => step.role === 'worker' && step.member.id === member.id)
    if (repeated && task.reworks >= task.limits.maxReworks) throw new Error('返工预算已耗尽，请增加预算后继续')
    const cwd = task.executionRoot ?? task.workspaceRoot
    const readOnly = role === 'leader' || member.access === 'read-only'
    const settings = await this.deps.settings(member, readOnly, cwd)
    const [generalMemory, workspaceMemory] = await Promise.all([this.readMemory(member.id), this.readMemory(member.id, task.workspaceRoot)])
    const memoryText = `## 通用经验\n${generalMemory.content}\n\n## 当前工作区经验\n${workspaceMemory.content}`
    let history = ''
    for (const step of task.steps.filter((s) => s.role === 'worker').slice(-6)) {
      const run = this.runFor(step)
      if (!run) continue
      const result = run.status === 'completed' ? await this.runs.loadResult(run.runId) : `状态：${run.status}`
      history += `\n### ${step.member.name} / ${step.id}\n工作目录：${run.workspaceRoot}\n${result.slice(0, 10000)}${result.length > 10000 ? '\n[结果已截断，请检查工作目录和会话]' : ''}\n`
    }
    if (member.skills.length) {
      const available = await this.deps.skills(cwd)
      if (member.skills.some((s) => !available.some((a) => a.enabled && a.path === s.path && a.name === s.name))) throw new Error('成员选择的 Skill 不可用，请修正配置后新建任务')
    }
    const stepId = crypto.randomUUID()
    const step: TeamStep = { id: stepId, member: clone(member), role, instruction, runId: stepId, consumed: false, createdAt: this.now() }
    if (repeated) task.reworks++
    task.steps.push(step)
    // Durable dispatch intent + compare-and-swap happen before any model request.
    await this.updateTask(task)
    const prompt = memberPrompt(task, member, instruction, memoryText.slice(0, 24000) + (memoryText.length > 24000 ? '\n[记忆已截断]' : ''), history, role === 'leader')
    const run = await this.runs.start({
      runId: step.id, instanceId: 'builtin.teams:default', provider: member.provider, title: `${task.title} · ${member.name}`,
      mode: 'detached', workspaceAccess: readOnly ? 'read-only' : task.executionRoot ? 'shared-write' : 'isolated-delivery',
      workspaceRoot: cwd, parentThreadId: task.parentThreadId, prompt, settings, skills: member.skills,
      beforeStart: async () => {
        const document = await this.deps.read('state')
        const saved = parseState(document.content).tasks.find((t) => t.id === task.id)
        if (!saved || saved.owner !== this.owner || saved.status !== 'running' || saved.steps.at(-1)?.id !== step.id) throw new Error('任务调度已被暂停、停止或接管')
        if (saved.deadline && this.now() >= saved.deadline) throw new Error('时间预算已耗尽')
      },
    })
    step.runId = run.runId
    if (!readOnly) task.executionRoot = run.workspaceRoot
    try { await this.updateTask(task) }
    catch (error) {
      // A pause/stop in another window can arrive while a model request is starting.
      // Cancel before more disk IO: a storage failure must not leave an orphan running.
      await this.runs.cancel(run.runId)
      await this.load()
      const latest = clone(this.task(this.value.state, task.id))
      const pending = latest.steps.find((s) => s.id === step.id)
      if (pending) {
        pending.runId = run.runId
        if (!readOnly) latest.executionRoot = run.workspaceRoot
        await this.updateTask(latest)
      }
      throw error
    }
  }
}
