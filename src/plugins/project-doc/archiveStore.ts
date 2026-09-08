import type { ArchiveDraft } from './config'

/**
 * 归档流程的进程内状态（模块级单例）。
 *
 * project-doc 插件的归档按钮触发 run；本 store 跟踪"进行中 / 待确认 / 失败"。
 * App 订阅它渲染右上角通知条；点通知后把"待打开的项目 + 草稿"写进 openRequest，
 * 项目 Tab 订阅它自动选中该项目并进入 archive 确认视图。
 * 待确认草稿持久化在插件 storage（ArchiveDraft），本 store 只放轻量状态 + 内存索引。
 */

export type ArchiveNotice =
  | { kind: 'running'; projectId: string; threadId: string }
  | { kind: 'pending'; projectId: string; threadId: string; draft: ArchiveDraft }
  | { kind: 'failed'; projectId: string; threadId: string; message: string }

export interface ArchiveState {
  /** 每个项目一条最新通知（同项目重复归档覆盖旧的）。 */
  notices: Record<string, ArchiveNotice>
  /** 待打开的归档确认请求（点通知后由项目 Tab 消费；确认/放弃后清空）。 */
  openRequest: { projectId: string; draft: ArchiveDraft } | null
  /** 待选中的项目（会话头部项目 chip 触发；项目 Tab 消费后清空）。不进 archive 视图。 */
  selectRequest: { projectId: string } | null
}

type Listener = () => void

export interface ArchiveStore {
  getState(): ArchiveState
  subscribe(listener: Listener): () => void
  setRunning(projectId: string, threadId: string): void
  setPending(projectId: string, threadId: string, draft: ArchiveDraft): void
  setFailed(projectId: string, threadId: string, message: string): void
  /** 关闭某项目的通知（人点了通知 / 手动关掉 / 确认完成）。 */
  dismiss(projectId: string): void
  /** 点通知：记录待打开的确认请求（项目 Tab 据此选中项目并进 archive 视图）。 */
  requestOpen(projectId: string, draft: ArchiveDraft): void
  /** 项目 Tab 消费完确认请求（保存/放弃）后清空。 */
  clearOpen(): void
  /** 会话头部项目 chip：只选中项目，不进 archive 视图。 */
  requestSelect(projectId: string): void
  /** 项目 Tab 消费完选中请求后清空。 */
  clearSelect(): void
}

export function createArchiveStore(): ArchiveStore {
  let state: ArchiveState = { notices: {}, openRequest: null, selectRequest: null }
  const listeners = new Set<Listener>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  const setNotice = (projectId: string, notice: ArchiveNotice) => {
    state = { ...state, notices: { ...state.notices, [projectId]: notice } }
    notify()
  }
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setRunning: (projectId, threadId) => setNotice(projectId, { kind: 'running', projectId, threadId }),
    setPending: (projectId, threadId, draft) => setNotice(projectId, { kind: 'pending', projectId, threadId, draft }),
    setFailed: (projectId, threadId, message) => setNotice(projectId, { kind: 'failed', projectId, threadId, message }),
    dismiss: (projectId) => {
      if (!(projectId in state.notices)) return
      const next = { ...state.notices }
      delete next[projectId]
      state = { ...state, notices: next }
      notify()
    },
    requestOpen: (projectId, draft) => {
      state = { ...state, openRequest: { projectId, draft } }
      notify()
    },
    clearOpen: () => {
      if (!state.openRequest) return
      state = { ...state, openRequest: null }
      notify()
    },
    requestSelect: (projectId) => {
      state = { ...state, selectRequest: { projectId } }
      notify()
    },
    clearSelect: () => {
      if (!state.selectRequest) return
      state = { ...state, selectRequest: null }
      notify()
    },
  }
}

/** 模块级单例：App 与 project-doc 插件共享。 */
export const archiveStore = createArchiveStore()
