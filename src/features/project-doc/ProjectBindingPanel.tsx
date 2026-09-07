import { useEffect, useState } from 'react'
import { Link2, Link2Off, LoaderCircle, Lock, NotebookPen } from 'lucide-react'
import type { ProjectDocService } from '../../core/project-docs/types'
import { useProjectBinding } from './useProjectBinding'

/**
 * 新会话面板里的项目绑定入口（newThreadPanels slot）。
 *
 * 方案乙（见 .harness/project-doc-plugin-plan.md）：
 * - 第 0 轮：选择项目 → pending 意图，输入框出现项目背景折叠卡；改选/取消都允许。
 * - 第 1 轮发送后：绑定锁定（locked），此面板只读，不可改、不可解绑。
 * 折叠卡的显示/隐藏由 App 依据同一 service 的绑定状态驱动（subscribeBindings 同步）。
 */
export function ProjectBindingPanel({ service, threadId, workspaceRoot, onOpenProject }: {
  service: ProjectDocService
  threadId: string | null
  workspaceRoot: string | null
  onOpenProject: (projectId: string) => void
}) {
  const binding = useProjectBinding(service, threadId, workspaceRoot)

  if (!threadId) return null
  const { project, locked, loading } = binding

  return (
    <div className="project-binding-panel">
      <span className="project-binding-icon"><NotebookPen size={14} /></span>
      {locked && project ? (
        <>
          <span className="project-binding-text">
            已绑定项目「{project.name}」（v{project.currentSeq}），Agent 提议将走审批卡写入。
          </span>
          <span className="project-binding-actions">
            <button type="button" onClick={() => onOpenProject(project.projectId)} title="打开项目文档">
              查看
            </button>
            <span className="project-binding-locked" title="绑定已锁定，随会话固定">
              <Lock size={12} />已锁定
            </span>
          </span>
        </>
      ) : (
        <>
          <span className="project-binding-text">
            {project
              ? '绑定项目后，首页输入框会带上项目背景；发送第一轮后锁定。'
              : '绑定项目文档后，首页会注入项目背景，Agent 写入提议走审批卡。'}
          </span>
          <span className="project-binding-actions">
            {loading ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <BindingSelect
                service={service}
                currentProjectId={project?.projectId ?? null}
                onBind={(projectId) => void binding.bind(projectId)}
                onUnbind={() => void binding.unbind()}
                onOpenProject={onOpenProject}
                hasProject={Boolean(project)}
              />
            )}
          </span>
        </>
      )}
    </div>
  )
}

function BindingSelect({ service, currentProjectId, onBind, onUnbind, onOpenProject, hasProject }: {
  service: ProjectDocService
  currentProjectId: string | null
  onBind: (projectId: string) => void
  onUnbind: () => void
  onOpenProject: (projectId: string) => void
  hasProject: boolean
}) {
  const [projects, setProjects] = useState<ProjectMetaList>(null)

  useEffect(() => {
    let disposed = false
    void service.list()
      .then((list) => { if (!disposed) setProjects(list) })
      .catch(() => { if (!disposed) setProjects([]) })
    return () => { disposed = true }
  }, [service])

  if (projects === null) return <LoaderCircle className="spin" size={13} />
  if (projects.length === 0) return <small>先在项目 tab 创建项目</small>

  return (
    <>
      <select
        aria-label="绑定项目"
        value={currentProjectId ?? ''}
        onChange={(event) => {
          const value = event.target.value
          if (value) onBind(value)
          else onUnbind()
        }}
      >
        <option value="">不绑定项目</option>
        {projects.map((project) => (
          <option key={project.projectId} value={project.projectId}>{project.name}（v{project.currentSeq}）</option>
        ))}
      </select>
      {hasProject && currentProjectId && (
        <button type="button" onClick={() => onOpenProject(currentProjectId)} title="打开项目文档">查看</button>
      )}
      {hasProject && (
        <span className="project-binding-hint"><Link2 size={11} />第 0 轮可改，发送后锁定</span>
      )}
      {!hasProject && (
        <span className="project-binding-hint"><Link2Off size={11} />不绑定则首页不注入背景</span>
      )}
    </>
  )
}

type ProjectMetaList = Awaited<ReturnType<ProjectDocService['list']>> | null
