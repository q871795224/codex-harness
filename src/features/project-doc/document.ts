/**
 * 项目文档（活文档 / 共享白板）的纯逻辑：分区键、front matter 渲染、seq 写入语义常量。
 * 不依赖 IPC，可单测。与 handover/document.ts 同构。
 *
 * 设计见 .harness/agent-interaction.md 第七节。写入通道见 .harness/project-doc-fix-plan.md：
 * Agent 经 `project-doc propose` 命令回传（不再 emit `<project-doc-update>` 文本块）；
 * 受控区（status）写入必须经审批卡（CAS：base_seq == current_seq）；追加区免审批直落盘。
 * 分区是推荐约定，不是硬性 schema。
 */

/** 推荐分区键。append 区免审批；status 受控。 */
export const SECTION_KEYS = ['status', 'log', 'decisions', 'openQuestions'] as const
export type SectionKey = (typeof SECTION_KEYS)[number]

/** 追加区（免审批、append-only）。 */
export const APPEND_SECTIONS: ReadonlySet<SectionKey> = new Set(['log', 'decisions', 'openQuestions'])

/** 受控区（写入必须过审批卡 + CAS）。当前只有 status。 */
export const CONTROLLED_SECTIONS: ReadonlySet<SectionKey> = new Set(['status'])

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value)
}

/** 受控区写入必须携带 base_seq（CAS）；追加区不强制。 */
export function requiresBaseSeq(section: SectionKey): boolean {
  return CONTROLLED_SECTIONS.has(section)
}

/**
 * 校验一次写入在当前版本下是否允许。
 * - 受控区：必须 base_seq === currentSeq（CAS），否则冲突。
 * - 追加区：始终允许（落盘时由 Harness 按 seq 定序），不校验 base_seq。
 */
export type WriteCheck =
  | { ok: true; nextSeq: number }
  | { ok: false; reason: 'conflict'; currentSeq: number; baseSeq?: number }

export function checkWrite(section: SectionKey, baseSeq: number | undefined, currentSeq: number): WriteCheck {
  if (APPEND_SECTIONS.has(section)) {
    return { ok: true, nextSeq: currentSeq + 1 }
  }
  if (baseSeq === undefined || baseSeq !== currentSeq) {
    return { ok: false, reason: 'conflict', currentSeq, baseSeq }
  }
  return { ok: true, nextSeq: currentSeq + 1 }
}

export interface ProjectDocFrontMatterValues {
  docId: string
  seq: number
  /** 更新者：run id，或 'user' */
  updatedBy: string
  updatedAt: string
  /** 关联的 task / thread（可选） */
  task?: string
}

/**
 * 渲染落盘文档的 YAML 文件头：血缘与簿记元数据（Harness 管理）。
 * 只进 ~/.codex-harness/projects/<project-id>/current.md 的文件头，不进注入新会话的正文。
 */
export function renderProjectDocFrontMatter(values: ProjectDocFrontMatterValues): string {
  const lines = [
    '---',
    `doc_id: ${values.docId}`,
    `seq: ${values.seq}`,
    `updated_by: ${values.updatedBy}`,
    `updated_at: ${values.updatedAt}`,
  ]
  if (values.task) lines.push(`task: ${values.task}`)
  lines.push('---')
  return lines.join('\n')
}
