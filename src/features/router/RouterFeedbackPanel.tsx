import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '../../core/domain/codex'
import { readRouterFeedback } from '../../core/workspace-router/examples'
import type { RouterFeedbackRow } from '../../core/workspace-router/types'

export function RouterFeedbackPanel({ workspaces, active }: { workspaces: Workspace[]; active: boolean }) {
  const [rows, setRows] = useState<RouterFeedbackRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const nextOffset = useRef(0)
  const load = async (append = false) => {
    const request = ++sequence.current
    setBusy(true); setError('')
    try {
      const offset = append ? nextOffset.current : 0
      const page = await readRouterFeedback(offset)
      if (request !== sequence.current) return
      nextOffset.current = offset + page.data.length
      setRows(current => append ? [...new Map([...current, ...page.data].map(row => [row.id, row])).values()] : page.data); setHasMore(page.hasMore)
    } catch { if (request === sequence.current) setError('读取反馈失败，请重试。') }
    finally { if (request === sequence.current) setBusy(false) }
  }
  useEffect(() => {
    if (active) void load()
    return () => { sequence.current++ }
  }, [active])
  const name = (root: string | null) => root === null ? '通用会话' : workspaces.find(w => w.root === root)?.name ?? root
  return <div className="router-feedback-panel">
    <div className="router-panel-actions"><button type="button" disabled={busy} onClick={() => void load()}>刷新</button></div>
    {error && <p role="alert">{error}</p>}
    {!rows.length && !busy && !error && <p>暂无反馈</p>}
    {rows.length > 0 && <div className="router-feedback-table-wrap"><table className="router-feedback-table"><thead><tr><th>用户输入</th><th>工作区</th><th>反馈</th><th>时间</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.id}><td><p>{row.request ?? '来源消息不可用'}</p>{row.hasAttachments && <span>含附件</span>}</td><td>{name(row.chosen)}{row.feedback === 'inaccurate' && <> → {name(row.correct)}</>}</td><td><span className={`router-status ${row.feedback === 'accurate' ? 'ready' : 'error'}`}>{row.feedback === 'accurate' ? '准确' : '纠正'}</span></td><td><time>{new Date(row.at).toLocaleString()}</time></td></tr>)}
    </tbody></table></div>}
    {hasMore && <button type="button" disabled={busy} onClick={() => void load(true)}>加载更多</button>}
  </div>
}
