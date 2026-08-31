import { useEffect, useMemo, useState } from 'react'
import { Bot, Save } from 'lucide-react'
import type { AgentRunService } from '../../core/agent-runs/types'
import type { CodexModel } from '../../core/domain/codex'
import type { HarnessPlugin, PluginInstanceRecord, PluginSettingsProps } from '../../extensions/types'
import {
  DEFAULT_QUICK_AGENT_JOB,
  migrateQuickAgentInstances,
  newQuickAgentJob,
  readQuickAgentConfig,
  settingsForMode,
  type QuickAgentJob,
  type QuickAgentRunMode,
} from './config'

export const quickAgentPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.quick-agent',
    name: '快捷 Agent',
    description: '在独立会话中使用预设模型和权限执行固定 Job。',
    version: '1.2.0',
    engine: { codexHarness: '^0.3.0' },
    supportedScopes: ['global', 'workspace'],
  },
  allowMultipleInstancesPerScope: true,
  createInstanceConfig: () => ({ jobs: [newQuickAgentJob()] }),
  instanceLabel: (instance) => readQuickAgentConfig(instance.config).jobs[0]?.name ?? '新 Job',
  migrateInstances: migrateQuickAgentInstances,
  settings: QuickAgentSettings,
  activate(ctx) {
    const agentRuns = ctx.services.get<AgentRunService>('harness.agentRuns')
    const job = readQuickAgentConfig(ctx.config).jobs[0]
    if (!job) return
    ctx.slots.quickActions.register({
      id: job.id,
      label: job.name,
      async run({ checkoutRoot, threadId }) {
        if (!checkoutRoot) throw new Error('请先打开一个具有工作目录的会话。')
        if (job.completion === 'return-to-parent' && !threadId) throw new Error('结果回传需要从会话中启动。')
        await agentRuns.start({
          instanceId: ctx.instanceId,
          title: job.name,
          mode: job.completion === 'return-to-parent' ? 'delegated' : 'detached',
          workspaceAccess: job.workspaceAccess,
          workspaceRoot: checkoutRoot,
          parentThreadId: threadId,
          prompt: job.prompt,
          settings: settingsForMode(job),
        })
      },
    })
  },
}

export const quickAgentDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.quick-agent:default',
  pluginId: quickAgentPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: { jobs: [DEFAULT_QUICK_AGENT_JOB] },
  createdAt: 0,
  updatedAt: 0,
}

function QuickAgentSettings({ instance, models, saveConfig }: PluginSettingsProps) {
  const [job, setJob] = useState(() => readQuickAgentConfig(instance.config).jobs[0] ?? newQuickAgentJob())
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setJob(readQuickAgentConfig(instance.config).jobs[0] ?? newQuickAgentJob())
    setMessage(null)
  }, [instance.config, instance.instanceId])

  const valid = Boolean(job.name.trim() && job.prompt.trim() && job.model && job.effort)
  const updateJob = (patch: Partial<QuickAgentJob>) => {
    setJob((current) => ({ ...current, ...patch }))
    setMessage(null)
  }
  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setMessage(null)
    try {
      await saveConfig({ jobs: [{ ...job, name: job.name.trim(), prompt: job.prompt.trim() }] })
      setMessage('已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="quick-agent-settings">
      <div className="quick-agent-settings-intro">
        <span><Bot size={15} />当前实例对应一个 Job；使用左侧 + 新增具有独立归属的 Job。</span>
      </div>
      <JobEditor job={job} models={models} onChange={updateJob} />
      <div className="quick-agent-settings-save">
        <button type="button" disabled={!valid || saving} onClick={() => void save()}><Save size={14} />{saving ? '保存中…' : '保存 Job'}</button>
        {message && <span>{message}</span>}
      </div>
    </div>
  )
}

function JobEditor({ job, models, onChange }: {
  job: QuickAgentJob
  models: CodexModel[]
  onChange(patch: Partial<QuickAgentJob>): void
}) {
  const selectedModel = models.find((candidate) => candidate.model === job.model)
  const modelOptions = useMemo(
    () => selectedModel || !job.model ? models : [{ ...fallbackModel(job.model), model: job.model }, ...models],
    [job.model, models, selectedModel],
  )
  return (
    <article className="quick-agent-job-editor">
      <header><span>JOB</span></header>
      <label><span>名称</span><input value={job.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="例如：提交、推送并创建 MR" /></label>
      <label className="quick-agent-prompt"><span>Prompt</span><textarea value={job.prompt} onChange={(event) => onChange({ prompt: event.target.value })} rows={4} placeholder="写入发送给独立 Agent 的完整任务说明" /></label>
      <div className="quick-agent-job-options">
        <label><span>模型</span><select value={job.model} onChange={(event) => {
          const model = models.find((candidate) => candidate.model === event.target.value)
          onChange({ model: event.target.value, effort: preferredEffort(model) })
        }}>{modelOptions.map((model) => <option key={model.model} value={model.model}>{model.displayName}</option>)}</select></label>
        <label><span>推理强度</span><select value={job.effort} onChange={(event) => onChange({ effort: event.target.value })}>
          {effortOptions(selectedModel, job.effort).map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select></label>
        <label><span>运行模式</span><select value={job.mode} onChange={(event) => onChange({ mode: event.target.value as QuickAgentRunMode })}>
          <option value="yolo">YOLO</option><option value="auto-review">Auto-review</option><option value="manual">Manual</option>
        </select></label>
        <label><span>工作区</span><select value={job.workspaceAccess} onChange={(event) => onChange({ workspaceAccess: event.target.value as QuickAgentJob['workspaceAccess'] })}>
          <option value="read-only">只读（可并发）</option><option value="shared-write">共享写入（互斥）</option><option value="isolated-delivery">隔离交付（新 worktree）</option>
        </select></label>
        <label><span>结果处理</span><select value={job.completion} onChange={(event) => onChange({ completion: event.target.value as QuickAgentJob['completion'] })}>
          <option value="detached">独立查看</option><option value="return-to-parent">完成后可回传当前会话</option>
        </select></label>
      </div>
    </article>
  )
}

function preferredEffort(model: CodexModel | undefined): string {
  if (!model) return 'max'
  return model.supportedReasoningEfforts.some((option) => option.reasoningEffort === 'max') ? 'max' : model.defaultReasoningEffort
}

function effortOptions(model: CodexModel | undefined, current: string): string[] {
  const values = model?.supportedReasoningEfforts.map((option) => option.reasoningEffort) ?? []
  return values.includes(current) ? values : [current, ...values]
}

function fallbackModel(model: string): CodexModel {
  return { id: model, model, displayName: model, description: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'max', inputModalities: [], isDefault: false }
}
