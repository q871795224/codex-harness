export function resolveQuickPanelAnchor(composerVisible: boolean, measuredBottom: number | undefined): number | undefined {
  return composerVisible ? measuredBottom : undefined
}
