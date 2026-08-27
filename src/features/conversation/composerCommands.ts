export interface RawComposerCommand {
  name: 'raw'
}

export type ComposerCommand = RawComposerCommand

export function parseComposerCommand(text: string, hasAttachments: boolean): ComposerCommand | null {
  if (hasAttachments) return null
  return text.trim() === '/raw' ? { name: 'raw' } : null
}
