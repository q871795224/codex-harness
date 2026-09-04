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

export interface ProjectDocService {
  create(projectId: string, name: string): Promise<ProjectMeta>
  list(): Promise<ProjectMeta[]>
  get(projectId: string): Promise<ProjectMeta>
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
  bindThread(threadId: string, projectId: string): Promise<void>
  unbindThread(threadId: string): Promise<void>
}
