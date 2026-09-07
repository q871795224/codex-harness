import { useSyncExternalStore } from 'react'
import { Archive, CircleAlert, LoaderCircle, X } from 'lucide-react'
import { archiveStore, type ArchiveNotice } from '../../plugins/project-doc/archiveStore'

/**
 * 归档通知条（右上角，持久，可堆叠，可点击）。
 * 订阅 archiveStore；点击 pending 通知跳项目 Tab 确认，running/failed 可手动关闭。
 * 这是本轮的「简单通知」；统一通知中心后续单独立项（见 plan 文档）。
 */
export function ArchiveNoticeBar({ onOpenArchiveTab }: {
  /** 点击 pending 通知时调用（App 负责切到项目 Tab）；项目选择/草稿传递走 archiveStore.openRequest。 */
  onOpenArchiveTab: () => void
}) {
  const state = useSyncExternalStore(archiveStore.subscribe, archiveStore.getState)
  const notices = Object.values(state.notices)
  if (notices.length === 0) return null

  return (
    <div className="archive-notice-bar" role="region" aria-label="归档通知">
      {notices.map((notice) => (
        <ArchiveNoticeRow key={notice.projectId} notice={notice} onOpenArchiveTab={onOpenArchiveTab} />
      ))}
    </div>
  )
}

function ArchiveNoticeRow({ notice, onOpenArchiveTab }: {
  notice: ArchiveNotice
  onOpenArchiveTab: () => void
}) {
  if (notice.kind === 'running') {
    return (
      <div className="archive-notice running">
        <LoaderCircle className="spin" size={14} />
        <span>正在归档到项目…</span>
        <button type="button" className="archive-notice-close" onClick={() => archiveStore.dismiss(notice.projectId)} aria-label="关闭">
          <X size={13} />
        </button>
      </div>
    )
  }
  if (notice.kind === 'failed') {
    return (
      <div className="archive-notice failed">
        <CircleAlert size={14} />
        <span>归档失败：{notice.message}</span>
        <button type="button" className="archive-notice-close" onClick={() => archiveStore.dismiss(notice.projectId)} aria-label="关闭">
          <X size={13} />
        </button>
      </div>
    )
  }
  return (
    <button
      type="button"
      className="archive-notice pending"
      onClick={() => {
        archiveStore.requestOpen(notice.projectId, notice.draft)
        onOpenArchiveTab()
      }}
      title="查看并确认归档内容"
    >
      <Archive size={14} />
      <span>归档已就绪，点击确认写入项目文档</span>
      <span
        className="archive-notice-close"
        role="button"
        aria-label="关闭"
        onClick={(event) => {
          event.stopPropagation()
          archiveStore.dismiss(notice.projectId)
        }}
      >
        <X size={13} />
      </span>
    </button>
  )
}
