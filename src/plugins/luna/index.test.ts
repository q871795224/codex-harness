import { describe, expect, it } from 'vitest'
import { LUNA_DELEGATE_PROMPT } from './index'

describe('Luna delegate prompt', () => {
  it('uses the exact agreed plan-delegate request', () => {
    expect(LUNA_DELEGATE_PROMPT).toBe(
      '$plan-delegate 请基于当前会话已经对齐的目标、约束和验收要求，\n整理一份独立 handoff，并交给 Luna Max 实施。',
    )
    expect(LUNA_DELEGATE_PROMPT).not.toContain('不要传递当前会话历史')
  })
})
