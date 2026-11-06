import type { AgentRunService } from '../agent-runs/types'
import type { ProjectDocService } from '../project-docs/types'
import type { ProjectOnboardingService, OnboardingPorts, OnboardingSettings, OnboardingState } from './types'
import { chunkHistory, historySummaryPrompt, onboardingPrompt, parsePlan } from './prompt'

function waitForRun(runs: AgentRunService, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stop = () => {}
    const timer = setTimeout(() => { stop(); void runs.cancel(id).catch(() => {}); reject(new Error('整理超时，项目文档未保存')) }, 300_000)
    const check = () => {
      const run = runs.snapshot().find(r => r.runId === id)
      if (!run || !['completed', 'failed', 'cancelled'].includes(run.status)) return
      clearTimeout(timer); stop()
      if (run.status === 'completed') void runs.loadResult(id).then(resolve, reject)
      else reject(new Error(run.errorSummary || '整理未完成，项目文档未保存'))
    }
    stop = runs.subscribe(check); check()
  })
}

export function createProjectOnboarding(ports: OnboardingPorts, docs: ProjectDocService, runs: AgentRunService): ProjectOnboardingService {
  let cards: ReadonlyMap<string, OnboardingState> = new Map()
  const listeners = new Set<() => void>(), finishing = new Set<string>(), requesting = new Map<string, Promise<{requestId: string; phase: string}>>()
  const publish = (card: OnboardingState) => { cards = new Map(cards).set(card.source.threadId, card); listeners.forEach(fn => fn()) }
  const finish = async (card: OnboardingState) => {
    const id = card.source.threadId
    if (ports.busy(id) || finishing.has(id)) return
    finishing.add(id)
    try {
      await ports.source(id)
      if (ports.busy(id)) return
      await ports.finish(card.id, id, card.source.cwd)
      publish({ ...card, phase: 'done', detail: undefined })
    } catch (error) {
      if (message(error).includes('正在执行')) publish({ ...card, phase: 'binding', detail: '文档已保存，等待当前轮次结束后加入项目' })
      else publish({ ...card, phase: 'error', error: `文档已保存，绑定未完成：${message(error)}` })
    }
    finally { finishing.delete(id) }
  }
  const request: ProjectOnboardingService['request'] = (threadId, options = {}) => {
    const pending = requesting.get(threadId); if (pending) return pending
    const task = (async () => {
      const existing = cards.get(threadId)
      if (existing) return { requestId: existing.id, phase: existing.phase }
      if (await ports.binding(threadId)) throw new Error('当前会话已经绑定项目')
      const source = await ports.source(threadId)
      if (options.mode === 'join' && options.projectId) await docs.get(options.projectId)
      const card: OnboardingState = { id: crypto.randomUUID(), source, phase: 'confirm', mode: options.mode ?? 'create',
        name: options.name ?? source.title, projectId: options.projectId ?? '', requestedBy: options.requestedBy ?? 'user' }
      publish(card)
      return { requestId: card.id, phase: card.phase }
    })().finally(() => requesting.delete(threadId))
    requesting.set(threadId, task); return task
  }
  const confirm: ProjectOnboardingService['confirm'] = async (threadId, selection, settings) => {
    const previous = cards.get(threadId)
    if (!previous || !['confirm', 'error'].includes(previous.phase)) return
    if (ports.busy(threadId)) { publish({ ...previous, error: '请等当前轮次和后台任务结束后再开始' }); return }
    if (previous.receipt) { const ready = { ...previous, phase: 'binding' as const, error: undefined }; publish(ready); await finish(ready); return }
    let card: OnboardingState = { ...previous, ...selection, name: selection.name.trim(), phase: 'reading', error: undefined }
    // A retry may regenerate against a newer target, but retains its request ID.
    publish(card)
    const update = (patch: Partial<OnboardingState>) => { card = { ...card, ...patch }; publish(card) }
    try {
      if (previous.phase === 'error') {
        const saved = (await ports.saved?.() ?? []).find(r => r.requestId === card.id && r.threadId === threadId)
        if (saved) {
          update({receipt:{projectId:saved.projectId,seq:saved.seq},projectId:saved.projectId,name:saved.name,phase:'binding'})
          await finish(card); return
        }
      }
      if (selection.mode === 'create' && !card.name) throw new Error('请填写项目名称')
      if (selection.mode === 'join' && !card.projectId) throw new Error('请选择目标项目')
      if (await ports.binding(threadId)) throw new Error('当前会话已经绑定项目')
      const source = await ports.source(threadId)
      const history = await ports.history(source)
      if (ports.busy(threadId)) throw new Error('会话已继续执行，请结束后重新确认')
      if (!history.length) throw new Error('当前会话还没有可总结的对话')
      const target = selection.mode === 'join' ? await ports.project(card.projectId) : null
      if (target && (!target.consistent || target.content.length > 180_000)) throw new Error('目标文档过长或存在协议外修改，请先检查或人工精简后重试')
      const run = async (prompt: string, title: string) => {
        const task = await runs.start({ instanceId: settings.instanceId, provider: 'codex', title, mode: 'detached', workspaceAccess: 'read-only',
          workspaceRoot: source.cwd, parentThreadId: threadId, prompt,
          settings: { model: settings.model, effort: settings.effort, serviceTier: null, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'read-only' } })
        return waitForRun(runs, task.runId)
      }
      let chunks = chunkHistory(history)
      update({ phase: 'running', messages: history.length, chunks: chunks.length, completedChunks: 0, detail: '正在整理会话结论' })
      for (let depth = 0; chunks.length > 1; depth++) {
        if (depth >= 4) throw new Error('历史仍超过整理上下文，请缩小范围后重试；原文未修改')
        const summaries: string[] = []
        for (let i = 0; i < chunks.length; i++) {
          update({ detail: `正在整理历史 ${i + 1}/${chunks.length}`, chunks: chunks.length, completedChunks: i })
          summaries.push(await run(historySummaryPrompt(chunks[i], i, chunks.length), '整理会话历史'))
        }
        const previousLength = chunks.join('').length
        chunks = chunkHistory(summaries)
        if (chunks.length > 1 && chunks.join('').length >= previousLength) throw new Error('分段历史未能缩短，请重试；未丢弃历史内容')
      }
      update({ detail: '正在生成项目记忆' })
      const plan = parsePlan(await run(onboardingPrompt(chunks[0], target), selection.mode === 'create' ? '从会话建立项目' : '补记会话到项目'))
      if (!target && !plan.status) throw new Error('新项目整理结果缺少概况')
      const projectId = target?.projectId ?? `project-${card.id}`
      update({ phase: 'saving', projectId, detail: '正在保存项目文档' })
      const receipt = await ports.commit({ ...plan, requestId: card.id, threadId, projectId, name: target ? null : card.name, baseSeq: target?.currentSeq ?? null })
      update({ receipt, phase: 'binding', detail: '文档已保存，等待当前轮次结束后加入项目' })
      await finish(card)
    } catch (error) { update({ phase: 'error', error: message(error), detail: undefined }) }
  }
  return {
    snapshot: () => cards,
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, request, confirm,
    listProjects: () => docs.list(),
    dismiss: id => {
      const card = cards.get(id)
      if (!card || !['confirm', 'done', 'error'].includes(card.phase) || (card.receipt && card.phase !== 'done')) return
      cards = new Map(cards); (cards as Map<string, OnboardingState>).delete(id); listeners.forEach(fn => fn())
    },
    resumeBindings: async () => { await Promise.all([...cards.values()].filter(c => c.phase === 'binding').map(finish)) },
    restoreSaved: async () => {
      for (const saved of await ports.saved?.() ?? []) {
        if (cards.has(saved.threadId)) continue
        try {
          const source = await ports.source(saved.threadId)
          const card: OnboardingState = { id: saved.requestId, source, mode: 'join', name: saved.name, projectId: saved.projectId,
            phase: 'binding', requestedBy: 'user', receipt: {projectId: saved.projectId, seq: saved.seq}, detail: '文档已保存，继续完成会话绑定' }
          publish(card); await finish(card)
        } catch { /* Keep the native receipt; retry when the source becomes available. */ }
      }
    },
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
