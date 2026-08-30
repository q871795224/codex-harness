export type UsageProviderId = 'codex-business' | 'codex-personal' | 'ais'
export type UsageProviderStatus = 'ready' | 'unavailable' | 'error'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  costUsd: number
}

export interface UsagePeriod extends UsageTotals {
  date: string
  models: UsageModel[]
}

export interface UsageModel extends UsageTotals {
  model: string
}

export interface UsageRateWindow {
  label: string
  usedPercent: number
  remainingPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface UsageBudget {
  usedUsd: number
  totalUsd: number
}

export interface UsageProvider {
  id: UsageProviderId
  label: string
  sourceKind: 'codex' | 'ais'
  status: UsageProviderStatus
  message: string | null
  totals: UsageTotals
  periods: UsagePeriod[]
  models: UsageModel[]
  quota: UsageRateWindow[]
  budget: UsageBudget | null
}

export interface UsageSnapshot {
  fetchedAt: number
  since: string
  until: string
  providers: UsageProvider[]
}

export interface UsageService {
  cachedSnapshot(since: string, until: string): Promise<UsageSnapshot | null>
  refreshSnapshot(since: string, until: string): Promise<UsageSnapshot>
}
