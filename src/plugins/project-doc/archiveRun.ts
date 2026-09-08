import { errorDetails, type NotificationService } from '../../core/notifications/store'
import type { AgentRunService } from '../../core/agent-runs/types'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { ThreadItemEntry } from '../../core/domain/codex'
import {
  collectArchiveMessages,
  renderArchivePrompt,
  renderArchiveTranscript,
} from '../../features/project-doc/archive'
import { sectionBody } from '../../features/project-doc/board'
import type { ProjectDocConfig, ArchiveDraft } from './config'
import type { ArchiveStore } from './archiveStore'

/**
 * 归档按钮的编排：起匿名 detached run 提炼 Status，产出暂存待人确认。
 * 见 .harness/project-doc-plugin-plan.md 第 2 节。
 */

export interface ArchiveRunDeps {
  agentRuns: AgentRunService
  projectDocs: ProjectDocService
  store: ArchiveStore
  notifications?: NotificationService
  /** 持久化待确认草稿（插件 storage.set）。 */
  persistDraft: (draft: ArchiveDraft) => Promise<void>
}

export interface ArchiveRunInput {
  instanceId: string
  threadId: string
  projectId: string
  provider: 'codex' | 'claude'
  workspaceRoot: string
  items: ThreadItemEntry[]
  config: ProjectDocConfig
}

/**
 * 启动一次归档 run。立即把通知置 running；后台跑 run、读结果、暂存草稿、置 pending。
 * 失败置 failed。这个函数不抛错（异步路径上错误都进 store）。
 */
export async function startArchiveRun(deps: ArchiveRunDeps, input: ArchiveRunInput): Promise<void> {
  const { store, projectDocs } = deps
  store.setRunning(input.projectId, input.threadId)
  const notification = { source: '项目归档', threadId: input.threadId, workspaceRoot: input.workspaceRoot, actions: [{ kind: 'project' as const, target: input.projectId, label: '打开项目' }] }
  const notificationId = deps.notifications?.publish({ ...notification, level: 'info', title: '正在整理项目归档', state: 'running' })
  try {
    const snapshot = await projectDocs.read(input.projectId)
    const currentStatus = sectionBody(snapshot.content, 'Status') ?? ''
    const messages = collectArchiveMessages(input.items, input.config.archiveTurns)
    if (messages.length === 0) throw new Error('当前会话没有可归档的对话内容。')
    const transcript = renderArchiveTranscript(messages)
    const prompt = renderArchivePrompt({
      template: input.config.archivePromptTemplate,
      currentStatus: currentStatus || '（空）',
      transcript,
    })

    const run = await deps.agentRuns.start({
      instanceId: input.instanceId,
      provider: input.provider,
      title: '归档到项目文档',
      mode: 'detached',
      workspaceAccess: 'read-only',
      workspaceRoot: input.workspaceRoot,
      parentThreadId: input.threadId,
      prompt,
      settings: {
        model: input.config.archiveModel,
        effort: input.config.archiveEffort,
        serviceTier: null,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxMode: 'read-only',
      },
    })

    const statusDraft = await waitForRunResult(deps.agentRuns, run.runId)
    const trimmed = statusDraft.trim()
    if (!trimmed) throw new Error('归档 Agent 没有产出内容。')

    const draft: ArchiveDraft = {
      projectId: input.projectId,
      statusDraft: trimmed,
      baseStatus: currentStatus,
      baseSeq: snapshot.currentSeq,
      threadId: input.threadId,
      createdAt: Date.now(),
    }
    await deps.persistDraft(draft)
    store.setPending(input.projectId, input.threadId, draft)
    deps.notifications?.publish({ ...notification, id: notificationId, level: 'info', title: '归档已就绪，等待确认', message: '打开项目查看归档内容，确认后写入项目文档。', state: 'pending' })
  } catch (error) {
    store.setFailed(input.projectId, input.threadId, messageOf(error))
    deps.notifications?.publish({ ...notification, id: notificationId, level: 'error', title: '项目归档未完成', message: '请查看详情后重新发起归档。', details: errorDetails(error), state: 'done' })
  }
}

/** 轮询 run 直到完成/失败，完成则返回最后一条 Agent 消息。 */
async function waitForRunResult(agentRuns: AgentRunService, runId: string): Promise<string> {
  const terminal = await new Promise<'completed' | 'failed'>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error('归档超时（5 分钟未完成）。'))
    }, 5 * 60 * 1000)
    const check = () => {
      const run = agentRuns.snapshot().find((candidate) => candidate.runId === runId)
      if (!run) return
      if (run.status === 'completed') {
        window.clearTimeout(timeout)
        unsubscribe()
        resolve('completed')
      } else if (run.status === 'failed' || run.status === 'cancelled') {
        window.clearTimeout(timeout)
        unsubscribe()
        resolve('failed')
      }
    }
    const unsubscribe = agentRuns.subscribe(check)
    check()
  })
  if (terminal === 'failed') {
    const run = agentRuns.snapshot().find((candidate) => candidate.runId === runId)
    throw new Error(run?.errorSummary ?? '归档任务失败。')
  }
  return agentRuns.loadResult(runId)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
