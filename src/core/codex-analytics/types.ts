export type CodexAnalyticsCounterMode = 'local' | 'official'
export interface CodexAnalyticsCounterStatus { mode: CodexAnalyticsCounterMode; apiKeyConfigured: boolean; localEstimator: string }
export interface CodexTokenBreakdown {
  totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number
}
export type HotspotKind = 'skill' | 'mcp' | 'agents'
export interface CodexAnalyticsQuery { since: number; until: number; model?: string; workspace?: string; threadId?: string; kind?: HotspotKind; name?: string; sort?: 'tokensDesc' | 'tokensAsc' | 'recent'; offset?: number }
export interface AnalyticsHotspot {
  kind: HotspotKind; name: string; calls: number; selected: number; reads: number; sessions: number; failed: number
  tokens: number; argumentTokens: number; resultTokens: number; missingCounts: number; workspaces: Array<{ workspace: string; calls: number; selected: number; reads: number; sessions: number }>
}
export interface AnalyticsSession { threadId: string; workspace: string; title: string | null; startedAt: number; turns: number; actual: CodexTokenBreakdown; incomplete: boolean; rerouted: boolean }
export interface AnalyticsContent { kind: HotspotKind | 'input'; name: string; at: number; selected: number; reads: number; status: string; tokens: number | null; argumentTokens: number | null; resultTokens: number | null; estimator: string }
export interface AnalyticsTurn { turnId: string; startedAt: number; model: string | null; source: string; status: string; actual: CodexTokenBreakdown; incomplete: boolean; rerouted: boolean; content: AnalyticsContent[] }
export interface CodexAnalyticsSnapshot {
  capturedSince: number; generatedAt: number; counter: CodexAnalyticsCounterStatus
  droppedEvents: number; writeErrors: number; officialFallbacks: number
  summary: { sessions: number; turns: number; actual: CodexTokenBreakdown; inputContentTokens: number; inputContentIncomplete: boolean; incompleteTurns: number; reroutedTurns: number }
  daily: Array<{ date: string; turns: number; actual: CodexTokenBreakdown; models: Array<{ model: string | null; actual: CodexTokenBreakdown }> }>
  models: Array<{ model: string | null; turns: number; sessions: number; actual: CodexTokenBreakdown; reroutedTurns: number; inputContentTokens: number; inputContentIncomplete: boolean }>
  workspaces: Array<{ workspace: string; sessions: number; turns: number; actual: CodexTokenBreakdown }>
  availableModels: string[]; hotspots: AnalyticsHotspot[]; sessions: AnalyticsSession[]; turns: AnalyticsTurn[]; totalSessions: number; totalTurns: number
}
export interface AnalyticsThreadUsage { estimatedUsageCreditsMicros: number; estimatedUsageUsdMicros: number | null; groups: Array<{ model: string | null; totalTokens: number | null; estimatedUsageCreditsMicros: number }> }
export interface AnalyticsCosts { models: Array<{ model: string | null; credits: number }>; message: string | null }
export interface CodexAnalyticsService {
  costs(query: CodexAnalyticsQuery): Promise<AnalyticsCosts>
  refreshMetadata(): Promise<number>
  threadUsage(threadId: string): Promise<AnalyticsThreadUsage | null>
  configure(mode: CodexAnalyticsCounterMode): Promise<CodexAnalyticsCounterStatus>
  snapshot(query: CodexAnalyticsQuery): Promise<CodexAnalyticsSnapshot>
}
