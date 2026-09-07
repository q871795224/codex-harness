export type CodexAnalyticsCounterMode = 'local' | 'official'
export interface CodexAnalyticsCounterStatus { mode: CodexAnalyticsCounterMode; apiKeyConfigured: boolean; localEstimator: string }
export interface CodexTokenBreakdown {
  totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number
}
export type HotspotKind = 'skill' | 'mcp' | 'agents'
export interface CodexAnalyticsQuery { since: number; until: number; model?: string; threadId?: string; kind?: HotspotKind; name?: string; sort?: 'tokensDesc' | 'tokensAsc' | 'recent'; offset?: number }
export interface AnalyticsHotspot {
  kind: HotspotKind; name: string; calls: number; selected: number; reads: number; sessions: number; failed: number
  tokens: number; argumentTokens: number; resultTokens: number; missingCounts: number
}
export interface AnalyticsSession { threadId: string; project: string; startedAt: number; turns: number; actual: CodexTokenBreakdown; incomplete: boolean; rerouted: boolean }
export interface AnalyticsContent { kind: HotspotKind | 'input'; name: string; at: number; selected: number; reads: number; status: string; tokens: number | null; argumentTokens: number | null; resultTokens: number | null; estimator: string }
export interface AnalyticsTurn { turnId: string; startedAt: number; model: string | null; source: string; status: string; actual: CodexTokenBreakdown; incomplete: boolean; rerouted: boolean; content: AnalyticsContent[] }
export interface CodexAnalyticsSnapshot {
  capturedSince: number; generatedAt: number; counter: CodexAnalyticsCounterStatus
  droppedEvents: number; writeErrors: number; officialFallbacks: number
  summary: { sessions: number; turns: number; actual: CodexTokenBreakdown; inputContentTokens: number; inputContentIncomplete: boolean; incompleteTurns: number; reroutedTurns: number }
  daily: Array<{ date: string; turns: number; actual: CodexTokenBreakdown }>
  models: Array<{ model: string | null; turns: number; sessions: number; actual: CodexTokenBreakdown; reroutedTurns: number }>
  availableModels: string[]; hotspots: AnalyticsHotspot[]; sessions: AnalyticsSession[]; turns: AnalyticsTurn[]; totalSessions: number; totalTurns: number
}
export interface CodexAnalyticsService {
  configure(mode: CodexAnalyticsCounterMode): Promise<CodexAnalyticsCounterStatus>
  snapshot(query: CodexAnalyticsQuery): Promise<CodexAnalyticsSnapshot>
}
