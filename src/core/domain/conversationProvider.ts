export type ConversationProvider = 'codex' | 'claude' | 'superbot'
export const conversationProviderLabels: Record<ConversationProvider, string> = { codex: 'Codex', claude: 'Claude', superbot: 'Superbot' }

export function nextConversationProvider(current: ConversationProvider, claudeAvailable: boolean): ConversationProvider {
  if (current === 'codex') return claudeAvailable ? 'claude' : 'superbot'
  return current === 'claude' ? 'superbot' : 'codex'
}
