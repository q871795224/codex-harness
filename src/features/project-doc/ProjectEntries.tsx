import { useState } from 'react'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { EntryMutation, ProjectDocSnapshot, ProjectEntry } from './types'
import { Markdown } from '../markdown/Markdown'

const LABELS: Record<ProjectEntry['state'], string> = {
  active: '有效', open: '待办', done: '已完成', deleted: '软删除', superseded: '被替代', revoked: '已撤销',
}
const ACTIONS: Record<EntryMutation['action'] | 'add', string> = {
  add: '新增', adopt: '纳管旧条目', update: '修改正文', supersede: '用新决定替代', delete: '软删除',
  restore: '恢复软删除前状态', revoke: '撤销', close: '完成', reopen: '重新打开',
}
function actions(entry: ProjectEntry): EntryMutation['action'][] {
  switch (entry.state) {
    case 'active': return ['update', 'supersede', 'revoke', 'delete']
    case 'open': return ['update', 'close', 'delete']
    case 'done': return ['update', 'reopen', 'delete']
    case 'deleted': return ['restore']
    case 'revoked': return ['delete']
    case 'superseded': return []
  }
}

/** Human edits use the same native entry operations as the Agent CLI. */
export function ProjectEntries({ service, projectId, snapshot, onChanged }: {
  service: ProjectDocService; projectId: string; snapshot: ProjectDocSnapshot; onChanged(): void
}) {
  const [editing, setEditing] = useState<ProjectEntry | null>(null)
  const [action, setAction] = useState<EntryMutation['action'] | 'add'>('add')
  const [section, setSection] = useState<'decisions' | 'openQuestions'>('decisions')
  const [content, setContent] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const needsContent = ['add', 'adopt', 'update', 'supersede'].includes(action)
  const options = editing ? actions(editing) : ['add', 'adopt'] as const
  const select = (entry: ProjectEntry | null) => {
    setEditing(entry); setAction(entry ? actions(entry)[0] : 'add'); setContent(entry?.content ?? '')
    setReason(''); setError('')
  }
  const save = async () => {
    if (!reason.trim() || (needsContent && !content.trim())) return
    setBusy(true); setError('')
    try {
      const outcome = action === 'add'
        ? await service.writeSection({ projectId, section, content, updatedBy: 'user', summary: reason })
        : await service.mutateEntry(projectId, {
          action, id: editing?.id, revision: editing?.revision, reason,
          ...(action === 'adopt' ? { section, baseSeq: snapshot.currentSeq } : {}),
          ...(needsContent ? { content } : {}),
        })
      if (outcome.kind === 'conflict') throw new Error('文档版本已更新，请刷新后重新选择条目。')
      select(null); onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <div className="project-entries">
    <p>决定和待办按条目维护；软删除、替代和完成都会保留正文及原因。旧文档可选取原文纳管。</p>
    {(snapshot.entries ?? []).map((entry) => <details key={entry.id}>
      <summary>{LABELS[entry.state]} · {entry.id} · {entry.content.split('\n')[0].slice(0, 60)}</summary>
      <p>修订 {entry.revision} · 原因：{entry.reason}{entry.replacedBy ? ` · 替代条目：${entry.replacedBy}` : ''}</p>
      <div className="markdown-body"><Markdown text={entry.content} /></div>
      {actions(entry).length > 0 && <button type="button" disabled={busy} onClick={() => select(entry)} aria-label={`维护 ${entry.id}`}>维护条目</button>}
    </details>)}
    <div className="project-edit-panel">
      {editing && <p>正在维护 {editing.id}（修订 {editing.revision}）</p>}
      <label>操作<select aria-label="条目操作" value={action} disabled={busy} onChange={(event) => {
        const next = event.target.value as typeof action; setAction(next)
        if (next === 'supersede') setContent('')
        else if (next === 'update') setContent(editing?.content ?? '')
      }}>{options.map((value) => <option key={value} value={value}>{ACTIONS[value]}</option>)}</select></label>
      {!editing && <label>分区<select aria-label="条目分区" value={section} disabled={busy} onChange={(event) => setSection(event.target.value as typeof section)}>
        <option value="decisions">Decisions</option><option value="openQuestions">Open Questions</option>
      </select></label>}
      {needsContent && <label>{action === 'adopt' ? '粘贴该分区完整且唯一的原文段落' : action === 'supersede' ? '新决定正文（旧决定保留）' : '正文'}
        <textarea aria-label="条目正文" value={content} disabled={busy} onChange={(event) => setContent(event.target.value)} rows={8} />
      </label>}
      <label>原因或完成证据<textarea aria-label="条目原因" value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} rows={2} /></label>
      {error && <><p role="alert" className="project-tab-error">{error}</p><button type="button" disabled={busy} onClick={onChanged}>刷新条目（保留草稿）</button></>}
      <div className="project-edit-actions">
        <button type="button" className="primary" disabled={busy || !reason.trim() || (needsContent && !content.trim())} onClick={() => void save()}>保存条目</button>
        {editing && <button type="button" disabled={busy} onClick={() => select(null)}>取消维护</button>}
      </div>
    </div>
  </div>
}
