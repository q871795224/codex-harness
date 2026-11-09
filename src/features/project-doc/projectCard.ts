import type { CollapsedPaste } from '../conversation/composerInput'

/** Project-bound composer card. Native tools use a short read notice (seq=null);
 * legacy conversations use the document snapshot and its sequence. Both are
 * consumed with the first accepted message and can be removed to unbind a draft. */

export const PROJECT_CARD_LABEL_PREFIX = '[项目: '

export interface ProjectCardSpec {
  projectId: string
  name: string
  seq: number | null
  /** 项目背景或原生工具的绑定提示；提示不关联正文版本，seq 为 null。 */
  content: string
}

/** 项目卡 label，如 `[项目: 我的项目 (seq 5)]`。 */
export function projectCardLabel(spec: Pick<ProjectCardSpec, 'name' | 'seq'>): string {
  const name = spec.name.replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名'
  return spec.seq === null ? `${PROJECT_CARD_LABEL_PREFIX}${name}]` : `${PROJECT_CARD_LABEL_PREFIX}${name} (seq ${spec.seq})]`
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
