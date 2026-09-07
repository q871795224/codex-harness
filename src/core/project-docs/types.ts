/**
 * 项目文档（活文档 / 共享白板）的核心服务契约。
 * 由 App 通过 services 提供（'harness.projectDocs'），插件与审批卡组件只依赖本接口。
 */

import type { SectionKey } from '../../features/project-doc/document'
import type {
  ProjectDocSnapshot,
  ProjectDocWriteOutcome,
  ProjectMeta,
  ProjectVersion,
} from '../../features/project-doc/types'

/**
 * 会话 ↔ 项目绑定的生命周期（方案乙，见 .harness/project-doc-plugin-plan.md 第 1 节）。
 * - pending：第 0 轮草稿态，可改可取消，发送第 1 轮才转 locked。
 * - locked：第 1 轮已发送，绑定锁死，只读不可改。
 * 旧的纯 projectId 字符串记录一律视为 locked（它们产生于即绑即锁的老逻辑）。
 */
export type ThreadProjectBindingPhase = 'pending' | 'locked'

export interface ThreadProjectBinding {
  projectId: string
  phase: ThreadProjectBindingPhase
}

export interface ProjectDocService {
  create(projectId: string, name: string): Promise<ProjectMeta>
  list(): Promise<ProjectMeta[]>
  get(projectId: string): Promise<ProjectMeta>
  rename(projectId: string, name: string): Promise<void>
  archive(projectId: string): Promise<void>
  bindWorkspace(projectId: string, workspaceRoot: string): Promise<void>
  workspaces(projectId: string): Promise<string[]>
  read(projectId: string): Promise<ProjectDocSnapshot>
  versions(projectId: string): Promise<ProjectVersion[]>
  writeSection(input: {
    projectId: string
    section: SectionKey
    baseSeq?: number
    content: string
    updatedBy: string
    summary?: string
  }): Promise<ProjectDocWriteOutcome>

  /** 会话 ↔ 项目绑定（UI 态，存 appState；正文与版本在 Rust store）。 */
  threadProject(threadId: string): Promise<string | null>
  /** 读取完整绑定（含 phase）。 */
  threadBinding(threadId: string): Promise<ThreadProjectBinding | null>
  /** 草稿态绑定/改绑（pending）。仅第 0 轮可调用。 */
  bindThread(threadId: string, projectId: string): Promise<void>
  /** 第 1 轮发送后调用：pending → locked。已是 locked 或无绑定则不动。 */
  lockThreadBinding(threadId: string): Promise<void>
  unbindThread(threadId: string): Promise<void>
  /** 订阅绑定变化（bind/lock/unbind 后触发）。service 是进程内单例，供 App 与插件面板共享同一数据源。 */
  subscribeBindings(listener: () => void): () => void
}
