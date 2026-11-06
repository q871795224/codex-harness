export interface RouterSummary {
  root: string
  checkoutRoot: string
  description: string
  checkedAt: number
  generatedAt: number | null
  error: boolean
  updating?: boolean
  nextCheckAt?: number | null
}
export interface RouterSummaryClaim {
  lease: string
  source: string
}
export interface RouterExample { request: string; wrong: string | null; correct: string | null }
export interface RouterPromptCandidate { root: string; checkoutRoot: string; name: string; description: string }
export interface RouterPromptInput {
  instructions: string
  schema: string
  userTexts: string[]
  candidates: RouterPromptCandidate[]
  examples: RouterExample[]
  tokenBudget: number
  exampleLimit?: number
}
export interface RouterPrompt { context: string; textTokens: number; examplesUsed: number }
export interface RouterCorrection {
  threadId: string; sourceTurnId: string; sourceMessageId: string
  wrong: string | null; correct: string | null
}

export interface RouterFeedback {
  id: string; threadId: string; sourceTurnId: string | null; sourceMessageId: string | null
  chosen: string | null; correct: string | null; feedback: 'accurate' | 'inaccurate'; at: number
}
export interface RouterFeedbackPage { data: RouterFeedback[]; hasMore: boolean }
export interface RouterFeedbackRow extends RouterFeedback { request: string | null; hasAttachments: boolean }

export interface DecisionPrompt { request: string; textTokens: number; examplesUsed: number }
export interface DecisionResult { primary: string | null; model: string; inputTokens: number }
