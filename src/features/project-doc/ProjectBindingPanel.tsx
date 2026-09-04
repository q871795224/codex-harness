import { useEffect, useState } from 'react'
import { Link2, Link2Off, LoaderCircle, NotebookPen } from 'lucide-react'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { ProjectMeta } from './types'

/**
 * 新会话面板里的项目绑定入口（newThreadPanels slot）。
 * 绑定后该会话的 Agent 提议才能经审批卡写入对应项目文档；绑定关系存 appState（UI 态）。
 */
export function ProjectBindingPanel({ service, threadId, workspaceRoot, onOpenProject }: {
  service: ProjectDocService
  threadId: string | null
  workspaceRoot: string | null
  onOpenProject: (projectId: string) => void
}) {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null)
  const [boundProjectId, setBoundProjectId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void service.list()
      .then((list) => { if (!disposed) setProjects(list) })
      .catch(() => { if (!disposed) setProjects([]) })
    return () => { disposed = true }
  }, [service])

  useEffect(() => {
    if (!threadId) {
      setBoundProjectId(null)
      return undefined
    }
    let disposed = false
    void service.threadProject(threadId)
      .then((projectId) => { if (!disposed) setBoundProjectId(projectId) })
      .catch(() => undefined)
    return () => { disposed = true }
  }, [service, threadId])

  if (!threadId) return null
  const boundProject = projects?.find((project) => project.projectId === boundProjectId) ?? null

  const bind = async (projectId: string) => {
    setBusy(true)
    setError(null)
    try {
      await service.bindThread(threadId, projectId)
      if (workspaceRoot) await service.bindWorkspace(projectId, workspaceRoot).catch(() => undefined)
      setBoundProjectId(projectId)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  const unbind = async () => {
    setBusy(true)
    setError(null)
    try {
      await service.unbindThread(threadId)
      setBoundProjectId(null)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-binding-panel">
      <span className="project-binding-icon"><NotebookPen size={14} /></span>
      {boundProject ? (
        <>
          <span className="project-binding-text">
            已绑定项目「{boundProject.name}」（v{boundProject.currentSeq}），Agent 提议将走审批卡写入。
          </span>
          <span className="project-binding-actions">
            <button type="button" onClick={() => onOpenProject(boundProject.projectId)} title="打开项目文档">
              查看
            </button>
            <button type="button" disabled={busy} onClick={() => void unbind()} title="解除绑定">
              {busy ? <LoaderCircle className="spin" size={12} /> : <Link2Off size={12} />}解绑
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="project-binding-text">绑定项目文档后，Agent 的写入提议会在这里过审批。</span>
          <span className="project-binding-actions">
            {projects === null ? (
              <LoaderCircle className="spin" size={13} />
            ) : projects.length === 0 ? (
              <small>先在项目 tab 创建项目</small>
            ) : (
              <select
                aria-label="绑定项目"
                disabled={busy}
                value=""
                onChange={(event) => {
                  if (event.target.value) void bind(event.target.value)
                }}
              >
                <option value="">选择项目…</option>
                {projects.map((project) => (
                  <option key={project.projectId} value={project.projectId}>{project.name}（v{project.currentSeq}）</option>
                ))}
              </select>
            )}
          </span>
        </>
      )}
      {error && <span className="project-binding-error">{error}</span>}
      {!boundProject && projects !== null && projects.length > 0 && (
        <span className="project-binding-hint"><Link2 size={11} />绑定按会话记忆</span>
      )}
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
