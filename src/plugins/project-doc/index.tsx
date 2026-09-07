import { Archive, LoaderCircle, NotebookPen } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AgentRunService } from '../../core/agent-runs/types'
import type { ProjectDocService } from '../../core/project-docs/types'
import type {
  ComposerActionProps,
  HarnessPlugin,
  PluginInstanceRecord,
  PluginSettingsProps,
} from '../../extensions/types'
import { ProjectTab } from '../../features/project-doc/ProjectTab'
import { ProjectBindingPanel } from '../../features/project-doc/ProjectBindingPanel'
import {
  ARCHIVE_DRAFT_STORAGE_KEY,
  createProjectDocInstanceConfig,
  readProjectDocConfig,
  type ArchiveDraft,
} from './config'
import { archiveStore } from './archiveStore'
import { startArchiveRun } from './archiveRun'

/**
 * 项目文档（活文档 / 共享白板）插件。
 *
 * - conversationTab「项目」：项目列表 → 详情（文档渲染、版本历史、编辑、冲突 diff）。
 * - newThreadPanels：会话 ↔ 项目绑定入口（方案乙：pending→locked，首轮注入项目背景卡）。
 * - composerActions「归档到项目」：起匿名 run 提炼会话进展进 Status，产出经人确认后落盘。
 *
 * 写入权始终在 Harness 核心（seq CAS 在 Rust 强制），插件只走 ProjectDocService。
 * Agent 主动写文档走 <project-doc-update> 审批卡（追加 Log）；归档按钮走编辑界面（覆盖 Status）。
 */
export const PROJECT_DOC_TAB_KEY = 'builtin.project-doc:projects'

export const projectDocPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.project-doc',
    name: '项目文档',
    description: '多 Agent 共享的活文档：首轮注入项目背景、审批卡写 Log、归档按钮提炼 Status。',
    version: '0.2.0',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
    supportedProviders: ['codex', 'claude'],
  },
  createInstanceConfig: createProjectDocInstanceConfig,
  settings: ProjectDocSettings,
  activate(ctx) {
    const service = ctx.services.get<ProjectDocService>('harness.projectDocs')

    ctx.slots.conversationTabs.register({
      id: 'projects',
      label: '项目',
      order: 30,
      icon: NotebookPen,
      focusable: true,
      hideComposer: false,
      render: () => <ProjectTabHost service={service} />,
    })

    ctx.slots.newThreadPanels.register({
      id: 'project-binding',
      order: 30,
      render: ({ threadId, workspaceRoot }) => (
        <ProjectBindingPanel
          service={service}
          threadId={threadId}
          workspaceRoot={workspaceRoot}
          onOpenProject={() => undefined}
        />
      ),
    })

    ctx.slots.composerActions.register({
      id: 'archive-to-project',
      order: 10,
      render: (props) => (
        <ArchiveButton
          props={props}
          service={service}
          agentRuns={ctx.services.get<AgentRunService>('harness.agentRuns')}
          instanceId={ctx.instanceId}
          config={readProjectDocConfig(ctx.config)}
          persistDraft={(draft) => ctx.storage.set(ARCHIVE_DRAFT_STORAGE_KEY, draft)}
        />
      ),
    })
  },
}

function ArchiveButton({ props, service, agentRuns, instanceId, config, persistDraft }: {
  props: ComposerActionProps
  service: ProjectDocService
  agentRuns: AgentRunService
  instanceId: string
  config: ReturnType<typeof readProjectDocConfig>
  persistDraft: (draft: ArchiveDraft) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const archive = async () => {
    setError(null)
    if (!props.threadId) { setError('需要在会话中使用。'); return }
    if (!props.checkoutRoot) { setError('请先打开一个具有工作目录的会话。'); return }
    const projectId = await service.threadProject(props.threadId)
    if (!projectId) { setError('当前会话未绑定项目。先在上方绑定项目。'); return }
    setBusy(true)
    try {
      await startArchiveRun(
        { agentRuns, projectDocs: service, store: archiveStore, persistDraft },
        {
          instanceId,
          threadId: props.threadId,
          projectId,
          provider: props.provider ?? 'codex',
          workspaceRoot: props.checkoutRoot,
          items: props.items,
          config,
        },
      )
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="project-archive-action">
      <button
        type="button"
        className="composer-icon-button"
        disabled={props.disabled || busy}
        onClick={() => void archive()}
        title="把最近会话进展提炼进项目文档 Status（需先绑定项目）"
        aria-label="归档到项目"
      >
        {busy ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}
      </button>
      {error && <span className="project-archive-error" role="alert">{error}</span>}
    </span>
  )
}

function ProjectDocSettings({ instance, models, saveConfig }: PluginSettingsProps) {
  const config = readProjectDocConfig(instance.config)
  const [model, setModel] = useState(config.archiveModel)
  const [effort, setEffort] = useState(config.archiveEffort)
  const [turns, setTurns] = useState(String(config.archiveTurns))
  const [template, setTemplate] = useState(config.archivePromptTemplate)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const selectedModel = models.find((candidate) => candidate.model === model)
  const effortOptions = selectedModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort)
    ?? [...new Set([effort, 'low', 'medium', 'high', 'max'])]

  const save = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const parsedTurns = Number.parseInt(turns, 10)
      await saveConfig({
        archiveModel: model,
        archiveEffort: effort,
        archiveTurns: Number.isFinite(parsedTurns) && parsedTurns > 0 ? parsedTurns : config.archiveTurns,
        archivePromptTemplate: template,
      })
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="project-doc-settings">
      <label>
        归档模型
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {models.length === 0 && <option value={model}>{model}</option>}
          {models.map((candidate) => (
            <option key={candidate.id} value={candidate.model}>{candidate.displayName}</option>
          ))}
        </select>
      </label>
      <label>
        推理强度
        <select value={effort} onChange={(event) => setEffort(event.target.value)}>
          {effortOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label>
        取最近几轮
        <input
          type="number"
          min={1}
          value={turns}
          onChange={(event) => setTurns(event.target.value)}
        />
      </label>
      <label className="project-doc-settings-template">
        归档 Prompt 模板
        <textarea
          rows={10}
          value={template}
          onChange={(event) => setTemplate(event.target.value)}
          spellCheck={false}
        />
        <small>{'支持占位符 {{currentStatus}}（当前 Status 正文）与 {{transcript}}（最近会话转录）。'}</small>
      </label>
      <div className="project-doc-settings-actions">
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="spin" size={12} /> : null}保存
        </button>
        {saved && <span className="project-doc-settings-saved">已保存</span>}
      </div>
    </div>
  )
}

function ProjectTabHost({ service }: { service: ProjectDocService }) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const archiveState = useSyncExternalStore(archiveStore.subscribe, archiveStore.getState)
  const openRequest = archiveState.openRequest

  // 点归档通知：自动选中对应项目，由 ProjectDetail 依据 archiveRequest 进 archive 确认视图。
  useEffect(() => {
    if (openRequest) setSelectedProjectId(openRequest.projectId)
  }, [openRequest])

  const archiveRequest = openRequest
    ? {
      statusDraft: openRequest.draft.statusDraft,
      baseStatus: openRequest.draft.baseStatus,
      baseSeq: openRequest.draft.baseSeq,
    }
    : null

  return (
    <ProjectTab
      service={service}
      selectedProjectId={selectedProjectId}
      conflictRequest={null}
      archiveRequest={archiveRequest}
      onSelectProject={setSelectedProjectId}
      onConflictHandled={() => undefined}
      onArchiveHandled={() => {
        if (openRequest) archiveStore.dismiss(openRequest.projectId)
        archiveStore.clearOpen()
      }}
    />
  )
}

export const projectDocDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.project-doc:default',
  pluginId: projectDocPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: createProjectDocInstanceConfig(),
  createdAt: 0,
  updatedAt: 0,
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
