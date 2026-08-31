export function resolveQuickPanelAnchor(composerVisible: boolean, measuredBottom: number | undefined): number | undefined {
  return composerVisible ? measuredBottom : undefined
}

export function shouldShowQuickPanels(activeConversation: boolean, composerVisible: boolean): boolean {
  return activeConversation && composerVisible
}
