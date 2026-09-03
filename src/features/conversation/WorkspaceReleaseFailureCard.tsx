import { CircleAlert, FileText, X } from 'lucide-react'
import { RELEASE_PHASE_LABELS, type WorkspaceReleaseController } from '../../core/release-command/types'
import { releaseFailureVisible } from '../../core/release-command/useWorkspaceRelease'

export function WorkspaceReleaseFailureCard({ release }: { release: WorkspaceReleaseController }) {
  const status = release.status
  if (!releaseFailureVisible(status) || !status) return null

  return (
    <article className="workspace-release-failure" role="alert">
      <CircleAlert size={17} />
      <div className="workspace-release-failure-copy">
        <strong>发布 {status.version} 失败</strong>
        <span>{RELEASE_PHASE_LABELS[status.phase] ?? status.phase}</span>
        <p>{status.error || '发布任务异常结束，请查看日志。'}</p>
      </div>
      <div className="workspace-release-failure-actions">
        <button type="button" onClick={() => void release.openLog()}><FileText size={13} />查看日志</button>
        <button type="button" className="icon" aria-label="关闭发布错误" title="关闭" onClick={() => void release.dismissFailure()}><X size={14} /></button>
      </div>
    </article>
  )
}
