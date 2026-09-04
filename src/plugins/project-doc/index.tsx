import { NotebookPen } from 'lucide-react'
import type { AgentRunService } from '../../core/agent-runs/types'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'
import { ProjectTab } from '../../features/project-doc/ProjectTab'
import { ProjectBindingPanel } from '../../features/project-doc/ProjectBindingPanel'
import { useState } from 'react'

/**
 * 项目文档（活文档 / 共享白板）插件。
 *
 * - conversationTab「项目」：项目列表 → 详情（文档渲染、版本历史、编辑、冲突 diff）。
 *   tab 自身不驱动导航；冲突 diff 由 App 在 setTab 前把请求暂存进项目 tab 的 pending state。
 * - newThreadPanels：会话 ↔ 项目绑定入口（绑定是审批卡写入的前提）。
 * - quickActions「项目看板 Run」：起独立 run 并把会话绑定到项目（场景二并行看板）。
 *
 * 写入权始终在 Harness 核心（seq CAS 在 Rust 强制），插件只走 ProjectDocService。
 */
export const PROJECT_DOC_TAB_KEY = 'builtin.project-doc:projects'

export const projectDocPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.project-doc',
    name: '项目文档',
    description: '多 Agent 共享的活文档：审批卡写 Status、seq 版本控制、并行进度看板。',
    version: '0.1.0',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
    supportedProviders: ['codex'],
  },
  activate(ctx) {
    const service = ctx.services.get<ProjectDocService>('harness.projectDocs')

    ctx.slots.conversationTabs.register({
      id: 'projects',
      label: '项目',
      order: 30,
      icon: NotebookPen,
      focusable: true,
      hideComposer: true,
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

    ctx.slots.quickActions.register({
      id: 'project-board-run',
      label: '项目看板 Run',
      description: '起独立 run 并把当前会话绑定到所选项目（场景二进度看板）',
      order: 40,
      async run(props) {
        if (!props.threadId) throw new Error('需要在会话中启动。')
        if (!props.checkoutRoot) throw new Error('请先打开一个具有工作目录的会话。')
        const agentRuns = ctx.services.get<AgentRunService>('harness.agentRuns')
        const projects = await service.list()
        const bound = await service.threadProject(props.threadId)
        const projectId = bound ?? projects[0]?.projectId
        if (!projectId) throw new Error('还没有项目，请先在项目 tab 创建。')
        if (!bound) await service.bindThread(props.threadId, projectId)
        await agentRuns.start({
          instanceId: ctx.instanceId,
          provider: props.provider ?? 'codex',
          title: `项目看板：${projects.find((p) => p.projectId === projectId)?.name ?? projectId}`,
          mode: 'detached',
          workspaceAccess: 'read-only',
          workspaceRoot: props.checkoutRoot,
          parentThreadId: props.threadId,
          prompt: `读取项目文档（projectId: ${projectId}）并把当前进展追加到 Log 分区。文档读写协议见 project-doc skill。`,
        })
      },
    })
  },
}

function ProjectTabHost({ service }: { service: ProjectDocService }) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  return (
    <ProjectTab
      service={service}
      selectedProjectId={selectedProjectId}
      conflictRequest={null}
      onSelectProject={setSelectedProjectId}
      onConflictHandled={() => undefined}
    />
  )
}

export const projectDocDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.project-doc:default',
  pluginId: projectDocPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}
