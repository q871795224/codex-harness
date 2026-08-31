import type { CodexModel, CodexServiceTier } from '../../core/domain/codex'

export function fastServiceTier(model: CodexModel | null): CodexServiceTier | null {
  return model?.serviceTiers?.find((tier) => tier.name.toLocaleLowerCase() === 'fast') ?? null
}

export function fastServiceTierTooltip(tier: CodexServiceTier): string {
  if (tier.description.trim().toLocaleLowerCase() === '1.5x speed, increased usage') {
    return 'Fast：生成速度提升 1.5 倍，使用额度消耗增加'
  }
  return `Fast：${tier.description}`
}
