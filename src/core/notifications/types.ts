export interface SystemNotificationInput {
  threadId: string
  turnId: string
  title: string
}

export interface SystemNotificationClick {
  threadId: string
}

export interface SystemNotificationService {
  requestPermission(): Promise<boolean>
  send(input: SystemNotificationInput): Promise<void>
  onClick(listener: (event: SystemNotificationClick) => void): Promise<() => void>
}
