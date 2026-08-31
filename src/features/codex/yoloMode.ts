import type { ThreadCodexSettings } from '../../core/domain/codex'

type YoloSettings = Pick<ThreadCodexSettings, 'approvalPolicy' | 'approvalsReviewer' | 'sandboxMode'>

export function isYoloMode(settings: ThreadCodexSettings): boolean {
  return settings.approvalPolicy === 'never' && settings.sandboxMode === 'danger-full-access'
}

export function yoloModeSettings(enabled: boolean): YoloSettings {
  return enabled
    ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access' }
    : { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxMode: 'workspace-write' }
}
