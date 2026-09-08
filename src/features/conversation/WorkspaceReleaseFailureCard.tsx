import { CircleAlert, CircleCheck, FileText, X } from 'lucide-react'
import { RELEASE_PHASE_LABELS, type WorkspaceReleaseController } from '../../core/release-command/types'
import { releaseFailureVisible, releaseWarningVisible } from '../../core/release-command/useWorkspaceRelease'

export function WorkspaceReleaseFailureCard({ release }: { release: WorkspaceReleaseController }) {
  const status = release.status
  if (!status) return null
  const warning = releaseWarningVisible(status)
  if (!warning && !releaseFailureVisible(status)) return null

  return (
    <article className={`workspace-release-failure${warning ? ' warning' : ''}`} role="alert">
      {warning ? <CircleCheck size={17} /> : <CircleAlert size={17} />}
      <div className="workspace-release-failure-copy">
        <strong>{warning ? `发布 ${status.version} 基本完成` : `发布 ${status.version} 失败`}</strong>
        <span>{warning ? '发布完成' : (RELEASE_PHASE_LABELS[status.phase] ?? status.phase)}</span>
        <p>{status.error || '发布任务异常结束，请查看日志。'}</p>
      </div>
      <div className="workspace-release-failure-actions">
        <button type="button" onClick={() => void release.openLog()}><FileText size={13} />查看日志</button>
        <button type="button" className="icon" aria-label="关闭发布提示" title="关闭" onClick={() => void release.dismissFailure()}><X size={14} /></button>
      </div>
    </article>
  )
}
