export type WorkspaceAppId = 'goland'

export interface WorkspaceDeliveryContext {
  branch: string | null
  remoteUrl: string | null
  reviewUrl: string | null
  reviewLabel: string | null
}

export interface AppLauncherService {
  open(appId: WorkspaceAppId, cwd: string): Promise<void>
  deliveryContext(cwd: string): Promise<WorkspaceDeliveryContext>
  openUrl(url: string): Promise<void>
}
