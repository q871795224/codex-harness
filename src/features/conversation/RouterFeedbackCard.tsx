import { Check, GitBranch } from 'lucide-react'
import { useState } from 'react'
import type { RouteRecord } from '../../core/workspace-router/service'

export function RouterFeedbackCard({ record, onFeedback }: { record: RouteRecord; onFeedback: (accurate: boolean, actual?: string | null) => Promise<void> }) {
  const [correcting, setCorrecting] = useState(false)
  const [actual, setActual] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (record.feedbackDismissedAt || record.feedback === 'implicit-accurate' || !record.choice || !['selected', 'started'].includes(record.status)) return null
  const name = (root: string | null) => record.candidates.find((item) => item.root === root)?.name ?? '通用会话'
  const save = async (accurate: boolean) => {
    setSaving(true); setError(null)
    try { await onFeedback(accurate, actual || null); setCorrecting(false) }
    catch (next) { setError(next instanceof Error ? next.message : String(next)) }
    finally { setSaving(false) }
  }
  return <div className="recap-banner router-feedback-card">
    <GitBranch size={14} aria-hidden />
    <div className="recap-banner-body">
      <strong>工作区路由</strong>
      <p>已自动选择 {name(record.choice.primary)}{record.choice.related.length ? ` · 可能涉及 ${record.choice.related.map(name).join('、')}` : ''}</p>
      <div className="router-feedback-actions">
        <button type="button" className="route-accurate" aria-pressed={record.feedback === 'accurate'} disabled={saving} onClick={() => void save(true)}>{record.feedback === 'accurate' && <Check size={12} aria-hidden />}准</button>
        <button type="button" className="route-inaccurate" aria-pressed={record.feedback === 'inaccurate'} disabled={saving} onClick={() => { setCorrecting(true); setActual(record.actualWorkspace ?? '') }}>{record.feedback === 'inaccurate' && <Check size={12} aria-hidden />}不准</button>
        {correcting && <><select aria-label="实际工作区" value={actual} disabled={saving} onChange={(event) => setActual(event.target.value)}>
          <option value="">通用会话</option>
          {record.candidates.map((candidate) => <option key={candidate.root} value={candidate.root}>{candidate.name} · {candidate.root}</option>)}
        </select><button type="button" disabled={saving} onClick={() => void save(false)}>保存反馈</button><button type="button" disabled={saving} onClick={() => setCorrecting(false)}>取消</button></>}
      </div>
      {record.feedback === 'inaccurate' && !correcting && <p>实际工作区：{name(record.actualWorkspace)}</p>}
      {correcting && <p>仅保存反馈，当前工作继续。</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  </div>
}
