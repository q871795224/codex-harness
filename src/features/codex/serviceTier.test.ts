import { describe, expect, it } from 'vitest'
import type { CodexModel } from '../../core/domain/codex'
import { fastServiceTier, fastServiceTierTooltip } from './serviceTier'

const model: CodexModel = {
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  description: '旗舰模型',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text'],
  isDefault: true,
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
}

describe('Fast service tier', () => {
  it('discovers the Fast tier from the App Server model catalog', () => {
    expect(fastServiceTier(model)).toEqual(model.serviceTiers?.[0])
    expect(fastServiceTier({ ...model, serviceTiers: [] })).toBeNull()
  })

  it('uses the current catalog wording as a concise Chinese tooltip', () => {
    expect(fastServiceTierTooltip(model.serviceTiers![0])).toBe('Fast：生成速度提升 1.5 倍，使用额度消耗增加')
  })
})
