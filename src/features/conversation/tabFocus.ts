import type { ConversationTabContribution } from '../../extensions/types'

export function conversationTabSupportsFocus(contribution: ConversationTabContribution | null): boolean {
  return contribution !== null && contribution.focusable !== false
}
