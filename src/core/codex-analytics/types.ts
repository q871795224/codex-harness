export type CodexAnalyticsRange = '7d' | '30d' | 'all'
export type CodexAnalyticsCounterMode = 'local' | 'official'

export interface CodexAnalyticsCounterStatus {
  mode: CodexAnalyticsCounterMode
  apiKeyConfigured: boolean
  localEstimator: string
}

export interface CodexTokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface CodexAnalyticsSnapshot {
  range: CodexAnalyticsRange
  generatedAt: number
  retention: 'permanent'
  estimatorVersion: string
  counter: CodexAnalyticsCounterStatus & {
    officialRequests: number
    officialSuccesses: number
    officialFailures: number
    officialFallbacks: number
  }
  summary: {
    sessions: number
    turns: number
    usageUpdates: number
    actual: CodexTokenBreakdown
    userChars: number
    estimatedUserTokens: number
    estimatedSkillTokens: number
    estimatedMcpTokens: number
    droppedEvents: number
    writeErrors: number
  }
  daily: Array<{
    date: string
    turns: number
    actualTotalTokens: number
    estimatedUserTokens: number
  }>
  sources: Array<{ id: string; label: string; turns: number; actualTotalTokens: number }>
  models: Array<{ model: string; turns: number; actualTotalTokens: number }>
  skills: Array<{ name: string; calls: number; chars: number; estimatedTokens: number }>
  mcpTools: Array<{
    server: string
    tool: string
    calls: number
    argumentChars: number
    resultChars: number
    estimatedTokens: number
  }>
  recentTurns: Array<{
    threadId: string
    turnId: string
    startedAt: number
    trigger: string | null
    model: string | null
    source: string
    userChars: number
    estimatedUserTokens: number
    actualTotalTokens: number
  }>
}

export interface CodexAnalyticsService {
  configure(mode: CodexAnalyticsCounterMode): Promise<CodexAnalyticsCounterStatus>
  snapshot(range: CodexAnalyticsRange): Promise<CodexAnalyticsSnapshot>
}
