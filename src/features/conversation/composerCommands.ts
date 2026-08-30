import type { ApprovalPolicy } from '../../core/domain/codex'

export interface RawComposerCommand {
  name: 'raw'
}

export type ComposerCommand = RawComposerCommand
  | { name: 'new' }
  | { name: 'reset' }
  | { name: 'model'; model: string }
  | { name: 'reasoning'; effort: string }
  | { name: 'permissions'; approvalPolicy: ApprovalPolicy }

export function parseComposerCommand(text: string, hasAttachments: boolean): ComposerCommand | null {
  if (hasAttachments) return null
  const command = text.trim()
  if (command === '/raw') return { name: 'raw' }
  if (command === '/new') return { name: 'new' }
  if (command === '/reset') return { name: 'reset' }
  const model = command.match(/^\/model\s+(\S+)$/)
  if (model) return { name: 'model', model: model[1] }
  const reasoning = command.match(/^\/reasoning\s+(\S+)$/)
  if (reasoning) return { name: 'reasoning', effort: reasoning[1] }
  const permissions = command.match(/^\/permissions\s+(on-request|untrusted|never)$/)
  return permissions ? { name: 'permissions', approvalPolicy: permissions[1] as ApprovalPolicy } : null
}
