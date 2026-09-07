import { describe, expect, it } from 'vitest'
import type { CollapsedPaste } from '../conversation/composerInput'
import {
  PROJECT_CARD_LABEL_PREFIX,
  findProjectCard,
  projectCardLabel,
  projectCardProjectId,
  projectCardRemoved,
} from './projectCard'

function paste(origin?: CollapsedPaste['origin']): CollapsedPaste {
  return { start: 0, end: 10, content: '正文', label: '[项目: x (seq 1)]', ...(origin ? { origin } : {}) }
}

describe('projectCard', () => {
  it('renders label with name and seq', () => {
    expect(projectCardLabel({ name: '我的项目', seq: 5 })).toBe('[项目: 我的项目 (seq 5)]')
    expect(projectCardLabel({ name: '  多空  格  ', seq: 0 })).toBe('[项目: 多空 格 (seq 0)]')
    expect(projectCardLabel({ name: '', seq: 1 })).toBe(`${PROJECT_CARD_LABEL_PREFIX}未命名 (seq 1)]`)
  })

  it('finds the project card among pastes by origin', () => {
    const pastes = [
      paste(),
      paste({ kind: 'project-doc', projectId: 'p1' }),
    ]
    expect(findProjectCard(pastes)?.origin?.projectId).toBe('p1')
    expect(projectCardProjectId(pastes)).toBe('p1')
  })

  it('returns null when no project card present', () => {
    expect(findProjectCard([paste()])).toBeNull()
    expect(projectCardProjectId([paste()])).toBeNull()
    expect(projectCardProjectId([])).toBeNull()
  })

  it('detects removal only when bound but card missing', () => {
    const withCard = [paste({ kind: 'project-doc', projectId: 'p1' })]
    const without = [paste()]
    expect(projectCardRemoved(withCard, 'p1')).toBe(false)
    expect(projectCardRemoved(without, 'p1')).toBe(true)
    expect(projectCardRemoved(without, null)).toBe(false)
    // 卡还在但 projectId 变了（切换项目时旧卡被替换前）也视为旧绑定被移除
    expect(projectCardRemoved(withCard, 'other')).toBe(true)
  })
})
