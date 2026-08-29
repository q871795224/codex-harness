export type QuickCommandId = 'vpn-on' | 'smc-login' | 'smc-login-test'

export interface QuickCommandResult {
  commandId: QuickCommandId
  success: boolean
  message: string
}

export interface QuickCommandService {
  run(commandId: QuickCommandId): Promise<QuickCommandResult>
}
