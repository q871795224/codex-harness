/**
 * 项目文档（活文档 / 共享白板）的纯逻辑：分区、提议块提取、front matter 渲染、seq 写入语义。
 * 不依赖 IPC，可单测。与 handover/document.ts 同构。
 *
 * 设计见 .harness/agent-interaction.md 第七节：
 * - Status / Decisions 等受控分区写入必须经审批卡（CAS：base_seq == current_seq）；
 * - Log 追加免审批，落盘时由 Harness 按 seq 定序；
 * - 分区是推荐约定，不是硬性 schema；handover 文档不强制分区。
 */

export const PROJECT_DOC_UPDATE_OPEN = '<project-doc-update>'
export const PROJECT_DOC_UPDATE_CLOSE = '</project-doc-update>'

/** 推荐分区键。append 区免审批；status / decisions 受控。 */
export const SECTION_KEYS = ['status', 'log', 'decisions', 'openQuestions'] as const
export type SectionKey = (typeof SECTION_KEYS)[number]

/** 追加区（免审批、append-only）。 */
export const APPEND_SECTIONS: ReadonlySet<SectionKey> = new Set(['log', 'decisions', 'openQuestions'])

/** 受控区（写入必须过审批卡 + CAS）。当前只有 status。 */
export const CONTROLLED_SECTIONS: ReadonlySet<SectionKey> = new Set(['status'])

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value)
}

/**
 * 一次 `<project-doc-update>` 提议：模型在输出里 emit 的结构化块。
 * Harness 流式扫描出它、渲染成审批卡；块本身不干事，写入权在 Harness。
 */
export interface ProjectDocUpdateProposal {
  /** 目标分区 */
  section: SectionKey
  /** 提议基于的文档版本（CAS）；追加区可省略 */
  baseSeq?: number
  /** 写入/追加的内容（markdown 片段） */
  content: string
  /** 可选版本戳；Harness 不认识时降级为"仅展示、不写入"（可见性兜底） */
  version?: number
}

/**
 * 从模型输出中提取所有 <project-doc-update> 块。
 * 块体是极简 key: value 头 + 空行 + 内容，例如：
 *
 *   <project-doc-update>
 *   section: status
 *   base_seq: 5
 *   version: 1
 *
 *   ### run-abc: 当前在做 X
 *   ...
 *   </project-doc-update>
 *
 * 无法识别 section、内容为空、头格式非法的块会被跳过（无害失败，Harness 不渲染对应卡片）。
 */
export function extractProjectDocUpdates(agentOutput: string): ProjectDocUpdateProposal[] {
  const proposals: ProjectDocUpdateProposal[] = []
  let cursor = 0
  while (true) {
    const start = agentOutput.indexOf(PROJECT_DOC_UPDATE_OPEN, cursor)
    if (start < 0) break
    const bodyStart = start + PROJECT_DOC_UPDATE_OPEN.length
    const end = agentOutput.indexOf(PROJECT_DOC_UPDATE_CLOSE, bodyStart)
    if (end < 0) break
    const body = agentOutput.slice(bodyStart, end)
    const parsed = parseUpdateBody(body)
    if (parsed) proposals.push(parsed)
    cursor = end + PROJECT_DOC_UPDATE_CLOSE.length
  }
  return proposals
}

/** 解析单个块体；非法返回 null（跳过该块）。 */
function parseUpdateBody(body: string): ProjectDocUpdateProposal | null {
  // 头部与内容用第一个空行分隔；没有空行则视为只有头（内容为空 → 非法）。
  const blankLine = body.search(/\r?\n\s*\r?\n/)
  if (blankLine < 0) return null
  const headerText = body.slice(0, blankLine)
  const content = body.slice(blankLine).replace(/^(\r?\n\s*)+/, '').replace(/\s+$/, '')
  if (!content) return null

  let section: SectionKey | null = null
  let baseSeq: number | undefined
  let version: number | undefined
  for (const rawLine of headerText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 0) return null // 头部出现非 key: value 行 → 非法
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'section') {
      if (!isSectionKey(value)) return null
      section = value
    } else if (key === 'base_seq') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0) return null
      baseSeq = n
    } else if (key === 'version') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0) return null
      version = n
    }
    // 未识别的 key 忽略（前向兼容，允许将来加字段）
  }
  if (!section) return null
  return { section, baseSeq, content, version }
}

/** 受控区写入必须携带 base_seq（CAS）；追加区不强制。 */
export function requiresBaseSeq(section: SectionKey): boolean {
  return CONTROLLED_SECTIONS.has(section)
}

/**
 * 校验一次写入在当前版本下是否允许。
 * - 受控区：必须 base_seq === currentSeq（CAS），否则返回冲突（应触发审批卡的冲突态）。
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
