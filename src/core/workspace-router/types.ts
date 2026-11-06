export interface RouterSummary {
  root: string
  checkoutRoot: string
  description: string
  checkedAt: number
  generatedAt: number | null
  error: boolean
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
}
export interface RouterPrompt { context: string; textTokens: number; examplesUsed: number }
export interface RouterCorrection {
  threadId: string; sourceTurnId: string; sourceMessageId: string
  wrong: string | null; correct: string | null
}
