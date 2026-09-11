import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { Workspace } from '../../core/domain/codex'
import { parseProjectBoard } from './board'
import type { ProjectDocSnapshot, ProjectMeta, ProjectVersion } from './types'
import type { SectionKey } from './document'

export interface ProjectTabConflictRequest {
  proposalContent: string
  section: string
}

/** 归档确认请求：人点归档通知后进入，展示 Agent 提炼的 Status 草稿与当前 Status 的 diff。 */
export interface ProjectTabArchiveRequest {
  /** Agent 提炼出的 Status 新内容（人可再改）。 */
  statusDraft: string
  /** 产出时读到的当前 Status（diff 对比基线）。 */
  baseStatus: string
  /** 产出时读到的 seq（保存冲突检测）。 */
  baseSeq: number
}

type DetailView = 'doc' | 'board' | 'edit' | 'history' | 'diff' | 'archive'

function ProjectMetaActions({ service, project, onChanged, onArchived }: {
  service: ProjectDocService
  project: ProjectMeta
  onChanged: () => void
  onArchived?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(project.name)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const update = async (archive: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (archive) await service.archive(project.projectId)
      else await service.rename(project.projectId, name.trim())
      setEditing(false)
      setConfirmArchive(false)
      onChanged()
      if (archive) onArchived?.()
    } catch (err) { setError(messageOf(err)) }
    finally { setBusy(false) }
  }
  return <div className="project-meta-actions">
    {editing ? <>
      <input aria-label="项目名称" value={name} onChange={(event) => setName(event.target.value)} />
      <button disabled={busy || !name.trim()} onClick={() => void update(false)}>保存名称</button>
      <button disabled={busy} onClick={() => setEditing(false)}>取消</button>
    </> : <button disabled={busy} onClick={() => { setName(project.name); setEditing(true) }}>重命名</button>}
    {confirmArchive ? <>
      <span>归档后保留文档和历史</span>
      <button disabled={busy} onClick={() => void update(true)}>确认归档</button>
      <button disabled={busy} onClick={() => setConfirmArchive(false)}>取消</button>
    </> : <button disabled={busy} onClick={() => setConfirmArchive(true)}>归档</button>}
    {error && <span role="alert" className="project-tab-error">{error}</span>}
  </div>
}

/**
 * 项目文档 tab：项目列表 → 详情（文档渲染、当前 seq、版本历史、编辑、冲突 diff）。
 * 编辑与 Agent 写入走同一条 `writeSection` 通道（updatedBy = 'user'），seq 校验在 Rust 强制。
 */
export function ProjectTab({ service, selectedProjectId, conflictRequest, archiveRequest, onSelectProject, onConflictHandled, onArchiveHandled, workspaces }: {
  service: ProjectDocService
  selectedProjectId: string | null
  conflictRequest: ProjectTabConflictRequest | null
  archiveRequest?: ProjectTabArchiveRequest | null
  onSelectProject: (projectId: string | null) => void
  onConflictHandled: () => void
  onArchiveHandled?: () => void
  /** Harness 已知工作区列表，用于把绑定的工作区 root 映射为名称。 */
  workspaces?: Workspace[]
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
        key={selectedProjectId}
        service={service}
        projectId={selectedProjectId}
        conflictRequest={conflictRequest}
        archiveRequest={archiveRequest ?? null}
        onBack={() => {
          onSelectProject(null)
          void refresh()
        }}
        onConflictHandled={onConflictHandled}
        onArchiveHandled={onArchiveHandled ?? (() => undefined)}
        onChanged={() => void refresh()}
      />
    )
  }

  return (
    <div className="project-tab">
      <header className="project-tab-header">
        <h2><NotebookPen size={16} />项目文档</h2>
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
        <div className="project-table-scroll"><table className="project-table">
          <thead><tr><th>项目名称</th><th>工作区</th><th>版本</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>
          {projects.map((project) => (
            <tr key={project.projectId}>
              <td onClick={() => onSelectProject(project.projectId)}><span className="project-name">{project.name}</span></td>
              <td><ProjectWorkspaceBadges service={service} projectId={project.projectId} workspaces={workspaces} /></td>
              <td>v{project.currentSeq}</td><td>{formatTime(project.updatedAt)}</td>
              <td><ProjectMetaActions service={service} project={project} onChanged={() => void refresh()} /></td>
            </tr>
          ))}
          </tbody>
        </table></div>
      )}
    </div>
  )
}

/**
 * 项目行的「工作区」单元格：拉取 projectId 已绑定的工作区 root 列表，
 * 优先用 Harness 已知 Workspace.name 显示；不在列表内（如已被清理）则回退为 root 末段。
 */
function ProjectWorkspaceBadges({ service, projectId, workspaces }: {
  service: ProjectDocService
  projectId: string
  workspaces?: Workspace[]
}) {
  const [roots, setRoots] = useState<string[] | null>(null)

  useEffect(() => {
    let disposed = false
    void service.workspaces(projectId)
      .then((list) => { if (!disposed) setRoots(list) })
      .catch(() => { if (!disposed) setRoots([]) })
    return () => { disposed = true }
  }, [service, projectId])

  if (roots === null) return <span className="project-workspace-loading"><LoaderCircle className="spin" size={11} /></span>
  if (roots.length === 0) return <span className="project-workspace-empty">—</span>
  const labelFor = (root: string) => {
    const known = workspaces?.find((candidate) => candidate.root === root)
    if (known?.name) return known.name
    const segments = root.split('/').filter(Boolean)
    return segments.at(-1) ?? root
  }
  return (
    <span className="project-workspaces">
      {roots.map((root) => (
        <span key={root} className="project-workspace-badge" title={root}>{labelFor(root)}</span>
      ))}
    </span>
  )
}

function ProjectCreateRow({ service, onCreated }: {
  service: ProjectDocService
  onCreated: (project: ProjectMeta) => void
}) {  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const composing = useRef(false)
  const creating = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || creating.current) return
    creating.current = true
    setBusy(true)
    setError(null)
    try {
      const projectId = `${slugify(trimmed) || 'project'}-${crypto.randomUUID().slice(0, 8)}`
      const project = await service.create(projectId, trimmed)
      setName('')
      onCreated(project)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      creating.current = false
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
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault()
            void create()
          }
        }}
      />
      <button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
        {busy ? <LoaderCircle className="spin" size={12} /> : <FilePlus2 size={12} />}创建
      </button>
      {error && <span className="project-tab-error">{error}</span>}
    </div>
  )
}

function ProjectDetail({ service, projectId, conflictRequest, archiveRequest, onBack, onConflictHandled, onArchiveHandled, onChanged }: {
  service: ProjectDocService
  projectId: string
  conflictRequest: ProjectTabConflictRequest | null
  archiveRequest: ProjectTabArchiveRequest | null
  onBack: () => void
  onConflictHandled: () => void
  onArchiveHandled: () => void
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

  // 归档确认请求到达：强制进 archive 视图。
  useEffect(() => {
    if (archiveRequest) setView('archive')
  }, [archiveRequest])

  return (
    <div className="project-tab">
      <header className="project-tab-header">
        <button type="button" className="project-back" onClick={onBack} title="返回项目列表">
          <ChevronLeft size={14} />项目
        </button>
        <h2>{meta?.name ?? projectId}</h2>
        {meta && <ProjectMetaActions service={service} project={meta} onChanged={() => { void reload(); onChanged() }} onArchived={onBack} />}
        {meta && <small>v{meta.currentSeq} · 更新于 {formatTime(meta.updatedAt)}</small>}
        <span className="project-tab-views">
          <button type="button" className={view === 'doc' ? 'active' : ''} onClick={() => setView('doc')} title="查看文档">
            <NotebookPen size={12} />文档
          </button>
          <button type="button" className={view === 'board' ? 'active' : ''} onClick={() => setView('board')} title="按 run 聚合的进度看板">
            <KanbanSquare size={12} />看板
          </button>
          <button type="button" className={view === 'edit' ? 'active' : ''} onClick={() => setView('edit')} title="编辑整篇文档（走 seq 校验）">
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
          ? <div className="project-doc-body markdown-body">{snapshot.content.trim()
              ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{snapshot.content}</ReactMarkdown>
              : <p className="project-tab-empty">项目文档尚未填写。点击「编辑」，基于模板补充目标与验收标准。</p>}
            </div>
          : <p className="project-tab-empty"><LoaderCircle className="spin" size={14} />加载中…</p>
      )}
      {view === 'board' && (
        snapshot
          ? <ProjectBoardView content={snapshot.content} />
          : <p className="project-tab-empty"><LoaderCircle className="spin" size={14} />加载中…</p>
      )}
      {view === 'edit' && snapshot && (
        <ProjectFullEditPanel
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
      {view === 'archive' && archiveRequest && snapshot && (
        <ProjectArchiveConfirmPanel
          service={service}
          projectId={projectId}
          snapshot={snapshot}
          request={archiveRequest}
          onSaved={() => {
            onArchiveHandled()
            void reload()
            onChanged()
            setView('doc')
          }}
          onCancel={() => {
            onArchiveHandled()
            setView('doc')
          }}
        />
      )}
    </div>
  )
}

/**
 * 归档确认面板：展示 Agent 提炼的 Status 草稿与当前 Status 的逐行 diff（绿增红减），
 * 人可再编辑后保存（writeSection(status, baseSeq)）。
 */
function ProjectArchiveConfirmPanel({ service, projectId, snapshot, request, onSaved, onCancel }: {
  service: ProjectDocService
  projectId: string
  snapshot: ProjectDocSnapshot
  request: ProjectTabArchiveRequest
  onSaved: () => void
  onCancel: () => void
}) {
  const [content, setContent] = useState(request.statusDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<number | null>(null)
  const rows = useMemo(() => buildLineDiff(request.baseStatus, content), [request.baseStatus, content])
  const seqDrift = snapshot.currentSeq !== request.baseSeq

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
        summary: '归档会话进展',
      })
      if (outcome.kind === 'applied') onSaved()
      else setConflict(outcome.currentSeq)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-edit-panel project-archive-confirm">
      <p className="project-edit-hint">
        归档确认（Status 区，当前 v{snapshot.currentSeq}）：下方为 Agent 提炼结果与当前 Status 的差异（绿=新增/改动，红=删除）。可直接编辑后保存。
      </p>
      {seqDrift && (
        <p className="project-tab-warning"><CircleAlert size={13} />归档产出后文档已被更新（产出基于 v{request.baseSeq}，当前 v{snapshot.currentSeq}），diff 以最新文档为基线可能有出入，请核对后再保存。</p>
      )}
      <div className="project-diff-body project-archive-diff" role="table" aria-label="归档草稿与当前 Status 差异">
        {rows.map((row, index) => (
          <div key={index} className={`project-diff-row ${row.kind}`}>
            <code>{row.left}</code>
            <code>{row.right}</code>
          </div>
        ))}
      </div>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        aria-label="编辑归档后的 Status"
        className="project-archive-textarea"
      />
      {error && <p className="project-tab-error">{error}</p>}
      {conflict !== null && (
        <p className="project-tab-warning">版本冲突：当前已是 v{conflict}。请放弃或基于最新版重新编辑。</p>
      )}
      <div className="project-edit-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}保存到项目文档
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          <X size={12} />放弃
        </button>
      </div>
    </div>
  )
}

/**
 * 编辑整篇文档：textarea 装完整正文（含所有分区），保存走 writeDocument（整文替换 + seq CAS）。
 * front matter 由 Rust 重建，不进编辑框。
 */
function ProjectFullEditPanel({ service, projectId, snapshot, onSaved, onCancel }: {
  service: ProjectDocService
  projectId: string
  snapshot: ProjectDocSnapshot
  onSaved: () => void
  onCancel: () => void
}) {
  const [content, setContent] = useState(() => snapshot.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<number | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    setConflict(null)
    try {
      const outcome = await service.writeDocument({
        projectId,
        baseSeq: snapshot.currentSeq,
        content,
        updatedBy: 'user',
        summary: '人编辑全文',
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
      <p className="project-edit-hint">编辑整篇文档（v{snapshot.currentSeq}），含所有分区。保存为整文替换，走 seq 校验；文件头（front matter）由 Harness 自动重建，无需填写。</p>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        aria-label="编辑整篇项目文档"
        className="project-edit-full-textarea"
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
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
