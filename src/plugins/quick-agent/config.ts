import type { ThreadCodexSettings } from '../../core/domain/codex'
import type { PluginInstanceRecord } from '../../extensions/types'

export type QuickAgentRunMode = 'yolo' | 'auto-review' | 'manual'

export interface QuickAgentJob {
  id: string
  name: string
  prompt: string
  model: string
  effort: string
  mode: QuickAgentRunMode
}

export interface QuickAgentConfig {
  jobs: QuickAgentJob[]
}

export const DEFAULT_QUICK_AGENT_JOB: QuickAgentJob = {
  id: 'builtin.commit-push-mr',
  name: '提交、推送并创建 MR',
  prompt: '当前分支已经开发完成。请检查当前工作区的改动，创建内容准确的 commit，推送当前分支，并创建 Merge Request。完成后返回 commit、远端分支和 MR 链接；如果无法安全完成，请明确说明阻塞原因。',
  model: 'gpt-5.6-luna',
  effort: 'max',
  mode: 'yolo',
}

export function newQuickAgentJob(): QuickAgentJob {
  return {
    id: crypto.randomUUID(),
    name: '新 Job',
    prompt: '',
    model: 'gpt-5.6-luna',
    effort: 'max',
    mode: 'yolo',
  }
}

export function migrateQuickAgentInstances(instances: PluginInstanceRecord[]): PluginInstanceRecord[] {
  return instances.flatMap((instance) => {
    const jobs = readQuickAgentConfig(instance.config).jobs
    if (jobs.length <= 1) return [instance]
    return jobs.map((job, index) => ({
      ...instance,
      instanceId: index === 0 ? instance.instanceId : `${instance.instanceId}:job:${job.id}`,
      config: { jobs: [job] },
      createdAt: instance.createdAt + index,
    }))
  })
}

export function readQuickAgentConfig(value: Readonly<Record<string, unknown>>): QuickAgentConfig {
  const rawJobs = Array.isArray(value.jobs) ? value.jobs : []
  const seen = new Set<string>()
  const jobs = rawJobs.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const value = candidate as Record<string, unknown>
    if (typeof value.id !== 'string' || !value.id || seen.has(value.id)) return []
    if (typeof value.name !== 'string' || typeof value.prompt !== 'string' || typeof value.model !== 'string' || typeof value.effort !== 'string') return []
    const mode = isRunMode(value.mode) ? value.mode : 'yolo'
    seen.add(value.id)
    return [{ id: value.id, name: value.name, prompt: value.prompt, model: value.model, effort: value.effort, mode }]
  })
  return { jobs }
}

export function settingsForMode(job: QuickAgentJob): ThreadCodexSettings {
  if (job.mode === 'yolo') {
    return { model: job.model, effort: job.effort, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access' }
  }
  if (job.mode === 'auto-review') {
    return { model: job.model, effort: job.effort, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxMode: 'workspace-write' }
  }
  return { model: job.model, effort: job.effort, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxMode: 'workspace-write' }
}

export function runModeLabel(mode: QuickAgentRunMode): string {
  if (mode === 'auto-review') return 'AUTO-REVIEW'
  if (mode === 'manual') return 'MANUAL'
  return 'YOLO'
}

function isRunMode(value: unknown): value is QuickAgentRunMode {
  return value === 'yolo' || value === 'auto-review' || value === 'manual'
}
