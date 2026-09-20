/** Vercel evaluation types. Credentials and endpoint selection stay native. */
export type JevJson = null | boolean | number | string | JevJson[] | { [key: string]: JevJson }

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'boolean'; instructions: string }

export interface JevRequest {
  state: string | JevJson[] | { [key: string]: JevJson }
  questions: Record<string, JevQuestion>
}

export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence?: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence?: number }
  | { type: 'boolean'; probability: number }

export interface JevResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage: { inputTokens: number; outputTokens: number }
  /** USD decimal strings from the gateway; null means not reported, not free. */
  costs: { cost: string | null; marketCost: string | null; gatewayCost: string | null }
}

export interface JevStatus {
  /** Local credential presence only; does not confirm remote access or credit. */
  configured: boolean
  model: string
}
