export type WorkspaceAppId = 'goland'

export interface AppLauncherService {
  open(appId: WorkspaceAppId, cwd: string): Promise<void>
}
