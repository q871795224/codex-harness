import { useEffect, useMemo, useState } from 'react'
import { Bot, Plus, Save, Trash2 } from 'lucide-react'
import type { AgentRunService } from '../../core/agent-runs/types'
import type { CodexModel } from '../../core/domain/codex'
import type { HarnessPlugin, PluginInstanceRecord, PluginSettingsProps } from '../../extensions/types'
import {
  DEFAULT_QUICK_AGENT_JOB,
  readQuickAgentConfig,
  runModeLabel,
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
    version: '1.0.0',
    engine: { codexHarness: '^0.3.0' },
    supportedScopes: ['global', 'workspace'],
  },
  settings: QuickAgentSettings,
  activate(ctx) {
    const agentRuns = ctx.services.get<AgentRunService>('harness.agentRuns')
    const { jobs } = readQuickAgentConfig(ctx.config)
    for (const [index, job] of jobs.entries()) {
      ctx.slots.quickActions.register({
        id: job.id,
        label: job.name,
        description: promptSummary(job.prompt),
        meta: `${modelLabel(job.model)} · ${job.effort} · ${runModeLabel(job.mode)}`,
        order: index,
        async run({ checkoutRoot }) {
          if (!checkoutRoot) throw new Error('请先打开一个具有工作目录的会话。')
          await agentRuns.start({
            instanceId: ctx.instanceId,
            title: job.name,
            mode: 'detached',
            workspaceRoot: checkoutRoot,
            prompt: job.prompt,
            settings: settingsForMode(job),
          })
        },
      })
    }
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
  const [jobs, setJobs] = useState(() => readQuickAgentConfig(instance.config).jobs)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setJobs(readQuickAgentConfig(instance.config).jobs)
    setMessage(null)
  }, [instance.config, instance.instanceId])

  const valid = jobs.every((job) => job.name.trim() && job.prompt.trim() && job.model && job.effort)
  const addJob = () => {
    setJobs((current) => [...current, {
      id: crypto.randomUUID(),
      name: '新 Job',
      prompt: '',
      model: 'gpt-5.6-luna',
      effort: 'max',
      mode: 'yolo',
    }])
    setMessage(null)
  }
  const updateJob = (id: string, patch: Partial<QuickAgentJob>) => {
    setJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job))
    setMessage(null)
  }
  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setMessage(null)
    try {
      await saveConfig({ jobs: jobs.map((job) => ({ ...job, name: job.name.trim(), prompt: job.prompt.trim() })) })
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
        <span><Bot size={15} />每个 Job 都会在当前 checkout 中启动独立会话。</span>
        <button type="button" onClick={addJob}><Plus size={14} />新增 Job</button>
      </div>
      {jobs.length === 0 && <div className="quick-agent-settings-empty">这个实例还没有 Job。</div>}
      {jobs.map((job, index) => (
        <JobEditor
          key={job.id}
          job={job}
          index={index}
          models={models}
          onChange={(patch) => updateJob(job.id, patch)}
          onRemove={() => setJobs((current) => current.filter((candidate) => candidate.id !== job.id))}
        />
      ))}
      <div className="quick-agent-settings-save">
        <button type="button" disabled={!valid || saving} onClick={() => void save()}><Save size={14} />{saving ? '保存中…' : '保存 Job'}</button>
        {message && <span>{message}</span>}
      </div>
    </div>
  )
}

function JobEditor({ job, index, models, onChange, onRemove }: {
  job: QuickAgentJob
  index: number
  models: CodexModel[]
  onChange(patch: Partial<QuickAgentJob>): void
  onRemove(): void
}) {
  const selectedModel = models.find((candidate) => candidate.model === job.model)
  const modelOptions = useMemo(
    () => selectedModel || !job.model ? models : [{ ...fallbackModel(job.model), model: job.model }, ...models],
    [job.model, models, selectedModel],
  )
  return (
    <article className="quick-agent-job-editor">
      <header><span>JOB {String(index + 1).padStart(2, '0')}</span><button type="button" onClick={onRemove} title="删除 Job"><Trash2 size={14} /></button></header>
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

function promptSummary(prompt: string): string {
  const summary = prompt.replace(/\s+/g, ' ').trim()
  return summary.length > 92 ? `${summary.slice(0, 91)}…` : summary
}

function modelLabel(model: string): string {
  if (model === 'gpt-5.6-luna') return 'Luna'
  if (model === 'gpt-5.6-terra') return 'Terra'
  if (model === 'gpt-5.6-sol') return 'Sol'
  return model
}
