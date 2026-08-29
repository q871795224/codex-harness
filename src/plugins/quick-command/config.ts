import type { QuickCommandId } from '../../core/quick-commands/types'

export interface QuickCommandDefinition {
  id: QuickCommandId
  label: string
  command: string
  order: number
}

export const QUICK_COMMANDS: QuickCommandDefinition[] = [
  { id: 'vpn-on', label: '连接 VPN', command: 'vpn-on', order: 10 },
  { id: 'smc-login', label: 'SMC 登录', command: 'smc login', order: 20 },
  { id: 'smc-login-test', label: 'SMC 测试环境登录', command: 'smc login --test', order: 30 },
]

export function readQuickCommandId(config: Readonly<Record<string, unknown>>): QuickCommandId {
  return QUICK_COMMANDS.some((command) => command.id === config.commandId)
    ? config.commandId as QuickCommandId
    : 'vpn-on'
}

export function quickCommandDefinition(commandId: QuickCommandId): QuickCommandDefinition {
  return QUICK_COMMANDS.find((command) => command.id === commandId) ?? QUICK_COMMANDS[0]
}
