/**
 * 项目文档的领域类型：与 Rust `project_doc_store.rs` 的序列化结构对应。
 * 见 .harness/agent-interaction.md 第七节。
 */

import type { SectionKey } from './document'

export interface ProjectMeta {
  projectId: string
  name: string
  currentSeq: number
  createdAt: number
  updatedAt: number
}

export interface ProjectVersion {
  seq: number
  updatedBy: string
  updatedAt: number
  summary: string
  contentHash: string
}

export interface ProjectDocSnapshot {
  projectId: string
  currentSeq: number
  content: string
  contentHash: string
  /** false = 文件可能被绕过协议修改（hash 漂移）。 */
  consistent: boolean
}

/** 写入结果：Applied = 成功并推进 seq；Conflict = base_seq 过期（应触发审批卡冲突态）。 */
export type ProjectDocWriteOutcome =
  | { kind: 'applied'; newSeq: number; contentHash: string }
  | { kind: 'conflict'; currentSeq: number; baseSeq: number | null }

export interface ProjectDocWriteInput {
  projectId: string
  section: SectionKey
  baseSeq?: number
  content: string
  updatedBy: string
  summary?: string
}
