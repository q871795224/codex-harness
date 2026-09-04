import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  ChevronLeft,
  CircleAlert,
  FilePlus2,
  GitCompareArrows,
  History,
  KanbanSquare,
  LoaderCircle,
  NotebookPen,
  Pencil,
  X,
} from 'lucide-react'
import type { ProjectDocService } from '../../core/project-docs/types'
import { parseProjectBoard } from './board'
import type { ProjectDocSnapshot, ProjectMeta, ProjectVersion } from './types'
import type { SectionKey } from './document'

export interface ProjectTabConflictRequest {
  proposalContent: string
  section: string
}

type DetailView = 'doc' | 'board' | 'edit' | 'history' | 'diff'

/**
 * 项目文档 tab：项目列表 → 详情（文档渲染、当前 seq、版本历史、编辑、冲突 diff）。
 * 编辑与 Agent 写入走同一条 `writeSection` 通道（updatedBy = 'user'），seq 校验在 Rust 强制。
 */
export function ProjectTab({ service, selectedProjectId, conflictRequest, onSelectProject, onConflictHandled }: {
  service: ProjectDocService
  selectedProjectId: string | null
  conflictRequest: ProjectTabConflictRequest | null
  onSelectProject: (projectId: string | null) => void
  onConflictHandled: () => void
}) {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setProjects(await service.list())
      setError(null)
    } catch (nextError) {
      setError(messageOf(nextError))
    }
  }, [service])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (selectedProjectId) {
    return (
      <ProjectDetail
        service={service}
        projectId={selectedProjectId}
        conflictRequest={conflictRequest}
        onBack={() => {
          onSelectProject(null)
          void refresh()
        }}
        onConflictHandled={onConflictHandled}
        onChanged={() => void refresh()}
      />
    )
  }

  return (
    <div className="project-tab">
      <header className="project-tab-header">
        <h2><NotebookPen size={16} />项目文档</h2>
        <small>多 Agent 共享的活文档；写入经审批 + seq 版本控制。</small>
      </header>
      {error && <p className="project-tab-error"><CircleAlert size={13} />{error}</p>}
      <ProjectCreateRow service={service} onCreated={(project) => {
        void refresh()
        onSelectProject(project.projectId)
      }} />
      {projects === null ? (
        <p className="project-tab-empty"><LoaderCircle className="spin" size={14} />加载中…</p>
      ) : projects.length === 0 ? (
        <p className="project-tab-empty">还没有项目。创建一个，或在会话里绑定后让 Agent 提议写入。</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.projectId}>
              <button type="button" onClick={() => onSelectProject(project.projectId)}>
                <strong>{project.name}</strong>
                <small>v{project.currentSeq} · {project.projectId}</small>
                <small>更新于 {formatTime(project.updatedAt)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ProjectCreateRow({ service, onCreated }: {
  service: ProjectDocService
  onCreated: (project: ProjectMeta) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const projectId = slugify(trimmed) || crypto.randomUUID().slice(0, 8)
      const project = await service.create(projectId, trimmed)
      setName('')
      onCreated(project)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-create-row">
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="新项目名称"
        aria-label="新项目名称"
        onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
      />
      <button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
        {busy ? <LoaderCircle className="spin" size={12} /> : <FilePlus2 size={12} />}创建
      </button>
      {error && <span className="project-tab-error">{error}</span>}
    </div>
  )
}

function ProjectDetail({ service, projectId, conflictRequest, onBack, onConflictHandled, onChanged }: {
  service: ProjectDocService
  projectId: string
  conflictRequest: ProjectTabConflictRequest | null
  onBack: () => void
  onConflictHandled: () => void
  onChanged: () => void
}) {
  const [meta, setMeta] = useState<ProjectMeta | null>(null)
  const [snapshot, setSnapshot] = useState<ProjectDocSnapshot | null>(null)
  const [versions, setVersions] = useState<ProjectVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<DetailView>('doc')

  const reload = useCallback(async () => {
    try {
      const [nextMeta, nextSnapshot, nextVersions] = await Promise.all([
        service.get(projectId),
        service.read(projectId),
        service.versions(projectId),
      ])
      setMeta(nextMeta)
      setSnapshot(nextSnapshot)
      setVersions(nextVersions)
      setError(null)
    } catch (nextError) {
      setError(messageOf(nextError))
    }
  }, [service, projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  // 冲突请求到达：强制进 diff 视图。
  useEffect(() => {
    if (conflictRequest) setView('diff')
  }, [conflictRequest])

  return (
    <div className="project-tab">
      <header className="project-tab-header">
        <button type="button" className="project-back" onClick={onBack} title="返回项目列表">
          <ChevronLeft size={14} />项目
        </button>
        <h2>{meta?.name ?? projectId}</h2>
        {meta && <small>v{meta.currentSeq} · 更新于 {formatTime(meta.updatedAt)}</small>}
        <span className="project-tab-views">
          <button type="button" className={view === 'doc' ? 'active' : ''} onClick={() => setView('doc')} title="查看文档">
            <NotebookPen size={12} />文档
          </button>
          <button type="button" className={view === 'board' ? 'active' : ''} onClick={() => setView('board')} title="按 run 聚合的进度看板">
            <KanbanSquare size={12} />看板
          </button>
          <button type="button" className={view === 'edit' ? 'active' : ''} onClick={() => setView('edit')} title="编辑 Status 区（走 seq 校验）">
            <Pencil size={12} />编辑
          </button>
          <button type="button" className={view === 'history' ? 'active' : ''} onClick={() => setView('history')} title="版本历史">
            <History size={12} />历史
          </button>
          {conflictRequest && (
            <button type="button" className={view === 'diff' ? 'active' : ''} onClick={() => setView('diff')} title="提议与当前版差异">
              <GitCompareArrows size={12} />差异
            </button>
          )}
        </span>
      </header>
      {error && <p className="project-tab-error"><CircleAlert size={13} />{error}</p>}
      {snapshot && !snapshot.consistent && (
        <p className="project-tab-warning"><CircleAlert size={13} />文档可能被绕过协议修改（内容 hash 漂移），最新库内版本为 v{snapshot.currentSeq}。</p>
      )}
      {view === 'doc' && (
        snapshot
          ? <div className="project-doc-body markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{snapshot.content}</ReactMarkdown></div>
          : <p className="project-tab-empty"><LoaderCircle className="spin" size={14} />加载中…</p>
      )}
      {view === 'board' && (
        snapshot
          ? <ProjectBoardView content={snapshot.content} />
          : <p className="project-tab-empty"><LoaderCircle className="spin" size={14} />加载中…</p>
      )}
      {view === 'edit' && snapshot && (
        <ProjectEditPanel
          service={service}
          projectId={projectId}
          snapshot={snapshot}
          onSaved={() => {
            void reload()
            onChanged()
            setView('doc')
          }}
          onCancel={() => setView('doc')}
        />
      )}
      {view === 'history' && (
        <ProjectHistory versions={versions} />
      )}
      {view === 'diff' && conflictRequest && (
        <ProjectDiffPanel
          proposalContent={conflictRequest.proposalContent}
          currentContent={snapshot?.content ?? ''}
          currentSeq={snapshot?.currentSeq ?? 0}
          section={conflictRequest.section}
          onDone={() => {
            onConflictHandled()
            setView('doc')
          }}
        />
      )}
    </div>
  )
}

function ProjectEditPanel({ service, projectId, snapshot, onSaved, onCancel }: {
  service: ProjectDocService
  projectId: string
  snapshot: ProjectDocSnapshot
  onSaved: () => void
  onCancel: () => void
}) {
  const [content, setContent] = useState(snapshot.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<number | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    setConflict(null)
    try {
      const outcome = await service.writeSection({
        projectId,
        section: 'status' satisfies SectionKey,
        baseSeq: snapshot.currentSeq,
        content,
        updatedBy: 'user',
        summary: '人编辑',
      })
      if (outcome.kind === 'applied') {
        onSaved()
      } else {
        setConflict(outcome.currentSeq)
      }
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-edit-panel">
      <p className="project-edit-hint">基于 v{snapshot.currentSeq} 编辑 Status 区；保存走与 Agent 写入相同的 seq 校验通道。</p>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        aria-label="编辑项目文档"
        rows={16}
      />
      {error && <p className="project-tab-error">{error}</p>}
      {conflict !== null && (
        <p className="project-tab-warning">版本冲突：当前已是 v{conflict}。请放弃或基于最新版重新编辑。</p>
      )}
      <div className="project-edit-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}保存
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          <X size={12} />取消
        </button>
      </div>
    </div>
  )
}

/**
 * 场景二看板：Status 区按 run 聚合（`### run-xxx: 标题`），Log 区按条目聚合（新的在前）。
 * 解析是展示层的尽力而为；文档缺 Status/Log 区时给空态提示，不报错。
 */
function ProjectBoardView({ content }: { content: string }) {
  const board = useMemo(() => parseProjectBoard(content), [content])
  if (!board.hasStatus && !board.hasLog) {
    return <p className="project-tab-empty">文档还没有 Status / Log 分区，看板无内容。让 Agent 按 project-doc 协议提议写入后这里会按 run 聚合。</p>
  }
  return (
    <div className="project-board">
      {board.hasStatus && (
        <section className="project-board-section">
          <h3><KanbanSquare size={14} />Status · 按 run</h3>
          {board.shared && <div className="project-board-shared markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{board.shared}</ReactMarkdown></div>}
          {board.runs.length === 0 ? (
            <p className="project-tab-empty">Status 区还没有 `### run-xxx` 子区。</p>
          ) : (
            <div className="project-board-runs">
              {board.runs.map((run) => (
                <article key={run.runId} className="project-board-run">
                  <header>
                    <code>{run.runId}</code>
                    {run.title && <strong>{run.title}</strong>}
                  </header>
                  {run.body && <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.body}</ReactMarkdown></div>}
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      {board.hasLog && (
        <section className="project-board-section">
          <h3><History size={14} />Log · 新的在前</h3>
          {board.logEntries.length === 0 ? (
            <p className="project-tab-empty">Log 区还没有条目。</p>
          ) : (
            <ol className="project-board-log">
              {board.logEntries.map((entry, index) => (
                <li key={index}><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry}</ReactMarkdown></div></li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  )
}

function ProjectHistory({ versions }: { versions: ProjectVersion[] | null }) {  if (versions === null) return <p className="project-tab-empty"><LoaderCircle className="spin" size={14} />加载中…</p>
  if (versions.length === 0) return <p className="project-tab-empty">还没有版本记录。</p>
  return (
    <ol className="project-history">
      {[...versions].reverse().map((version) => (
        <li key={version.seq}>
          <strong>v{version.seq}</strong>
          <span>{version.updatedBy}</span>
          <small>{formatTime(version.updatedAt)}</small>
          {version.summary && <p>{version.summary}</p>}
        </li>
      ))}
    </ol>
  )
}

function ProjectDiffPanel({ proposalContent, currentContent, currentSeq, section, onDone }: {
  proposalContent: string
  currentContent: string
  currentSeq: number
  section: string
  onDone: () => void
}) {
  const rows = useMemo(() => buildLineDiff(currentContent, proposalContent), [currentContent, proposalContent])
  return (
    <div className="project-diff-panel">
      <p className="project-edit-hint">
        冲突对比（{sectionLabel(section)} 区）：左为当前 v{currentSeq}，右为 Agent 提议。决定权在人——回到会话里覆盖（重读后重写）或放弃。
      </p>
      <div className="project-diff-body" role="table" aria-label="提议与当前版差异">
        {rows.map((row, index) => (
          <div key={index} className={`project-diff-row ${row.kind}`}>
            <code>{row.left}</code>
            <code>{row.right}</code>
          </div>
        ))}
      </div>
      <div className="project-edit-actions">
        <button type="button" className="primary" onClick={onDone}>
          <Check size={12} />已查看
        </button>
      </div>
    </div>
  )
}

interface DiffRow {
  kind: 'same' | 'added' | 'removed' | 'changed'
  left: string
  right: string
}

/** 极简逐行对齐：相同行同排，左侧多余记 removed，右侧多余记 added，同位不同记 changed。 */
function buildLineDiff(current: string, proposal: string): DiffRow[] {
  const leftLines = current.split('\n')
  const rightLines = proposal.split('\n')
  const rows: DiffRow[] = []
  const max = Math.max(leftLines.length, rightLines.length)
  for (let index = 0; index < max; index += 1) {
    const left = leftLines[index]
    const right = rightLines[index]
    if (left === undefined) rows.push({ kind: 'added', left: '', right: right ?? '' })
    else if (right === undefined) rows.push({ kind: 'removed', left, right: '' })
    else if (left === right) rows.push({ kind: 'same', left, right })
    else rows.push({ kind: 'changed', left, right })
  }
  return rows
}

function sectionLabel(section: string): string {
  const labels: Record<string, string> = {
    status: 'Status',
    log: 'Log',
    decisions: 'Decisions',
    openQuestions: 'Open Questions',
  }
  return labels[section] ?? section
}

function formatTime(ms: number): string {
  if (!ms) return '-'
  return new Date(ms).toLocaleString()
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
