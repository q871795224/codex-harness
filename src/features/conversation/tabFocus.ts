import type { ConversationTabContribution } from '../../extensions/types'

export function conversationTabSupportsFocus(contribution: ConversationTabContribution | null): boolean {
  return contribution !== null && contribution.focusable !== false
}

export function conversationComposerState(tab: string, active: boolean, contribution: ConversationTabContribution | null, collapsed: boolean) {
  const collapsible = tab !== 'chat'
  return { collapsible, visible: active && !contribution?.hideComposer && !(collapsible && collapsed) }
}
