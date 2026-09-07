import type { PluginInstanceRecord } from '../../extensions/types'
import { DEFAULT_ARCHIVE_PROMPT_TEMPLATE } from '../../features/project-doc/archive'

/**
 * 项目文档插件的实例配置（归档按钮）。
 * 见 .harness/project-doc-plugin-plan.md 第 3 节。
 */

export interface ProjectDocConfig {
  /** 归档 run 的模型。 */
  archiveModel: string
  /** 归档 run 的推理强度。 */
  archiveEffort: string
  /** 归档时取最近几轮会话。 */
  archiveTurns: number
  /** 归档 prompt 模板（含 {{currentStatus}} {{transcript}} 占位符）。 */
  archivePromptTemplate: string
}

export const DEFAULT_PROJECT_DOC_CONFIG: ProjectDocConfig = {
  archiveModel: 'gpt-5.6-luna',
  archiveEffort: 'max',
  archiveTurns: 10,
  archivePromptTemplate: DEFAULT_ARCHIVE_PROMPT_TEMPLATE,
}

export function readProjectDocConfig(value: Readonly<Record<string, unknown>>): ProjectDocConfig {
  return {
    archiveModel: typeof value.archiveModel === 'string' && value.archiveModel ? value.archiveModel : DEFAULT_PROJECT_DOC_CONFIG.archiveModel,
    archiveEffort: typeof value.archiveEffort === 'string' && value.archiveEffort ? value.archiveEffort : DEFAULT_PROJECT_DOC_CONFIG.archiveEffort,
    archiveTurns: typeof value.archiveTurns === 'number' && Number.isFinite(value.archiveTurns) && value.archiveTurns > 0
      ? Math.floor(value.archiveTurns)
      : DEFAULT_PROJECT_DOC_CONFIG.archiveTurns,
    archivePromptTemplate: typeof value.archivePromptTemplate === 'string' && value.archivePromptTemplate
      ? value.archivePromptTemplate
      : DEFAULT_PROJECT_DOC_CONFIG.archivePromptTemplate,
  }
}

export function createProjectDocInstanceConfig(): Record<string, unknown> {
  return { ...DEFAULT_PROJECT_DOC_CONFIG }
}

/** 归档产物暂存（存插件 storage，等人确认）。 */
export interface ArchiveDraft {
  projectId: string
  /** 提炼出的 Status 新内容（Agent 产出，人可在确认界面再改）。 */
  statusDraft: string
  /** 产出时读到的当前 Status（用于 diff 对比）。 */
  baseStatus: string
  /** 产出时读到的 seq（保存时若已变化则提示冲突）。 */
  baseSeq: number
  /** 触发归档的会话。 */
  threadId: string
  createdAt: number
}

export const ARCHIVE_DRAFT_STORAGE_KEY = 'archiveDraft.v1'

export function normalizeArchiveDraft(raw: unknown): ArchiveDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.projectId !== 'string' || !candidate.projectId) return null
  if (typeof candidate.statusDraft !== 'string') return null
  if (typeof candidate.baseStatus !== 'string') return null
  if (typeof candidate.baseSeq !== 'number') return null
  if (typeof candidate.threadId !== 'string') return null
  return {
    projectId: candidate.projectId,
    statusDraft: candidate.statusDraft,
    baseStatus: candidate.baseStatus,
    baseSeq: candidate.baseSeq,
    threadId: candidate.threadId,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
  }
}
