import type { CollapsedPaste } from '../conversation/composerInput'

/**
 * 项目背景折叠卡（首轮注入）的纯逻辑。
 *
 * 设计见 .harness/project-doc-plugin-plan.md 第 1 节「生命周期（方案乙）」：
 * - 折叠卡是草稿态 paste，`origin.kind === 'project-doc'`，仅在第 0 轮存在于输入框。
 * - 发送第 1 轮时随 expandedText 展开注入正文；发送后被消耗，不再注入。
 * - 卡的 label 显示「项目名 + seq」，content 是项目文档正文（仅正文，不含协议/seq 元数据）。
 */

export const PROJECT_CARD_LABEL_PREFIX = '[项目: '

export interface ProjectCardSpec {
  projectId: string
  name: string
  seq: number
  /** 项目文档正文（注入内容）。 */
  content: string
}

/** 项目卡 label，如 `[项目: 我的项目 (seq 5)]`。 */
export function projectCardLabel(spec: Pick<ProjectCardSpec, 'name' | 'seq'>): string {
  const name = spec.name.replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名'
  return `${PROJECT_CARD_LABEL_PREFIX}${name} (seq ${spec.seq})]`
}

/** 找出 pastes 里的项目背景卡（最多一张；一期一 thread 只能绑一个项目）。 */
export function findProjectCard(pastes: CollapsedPaste[]): CollapsedPaste | null {
  return pastes.find((paste) => paste.origin?.kind === 'project-doc') ?? null
}

/** 项目卡的 projectId（无则 null）。 */
export function projectCardProjectId(pastes: CollapsedPaste[]): string | null {
  return findProjectCard(pastes)?.origin?.projectId ?? null
}

/**
 * 检测项目卡是否仍在（用于「手动删卡 → 解绑」）。
 * 绑定意图存在但卡已不在 pastes 里，视为用户删掉了卡。
 */
export function projectCardRemoved(pastes: CollapsedPaste[], boundProjectId: string | null): boolean {
  if (!boundProjectId) return false
  return projectCardProjectId(pastes) !== boundProjectId
}
