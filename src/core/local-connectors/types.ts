export interface LocalConnectorMessage {
  id: string
  accountId: string
  direction: 'inbound' | 'outbound'
  platform: string
  conversationType: 'dm' | 'group' | 'thread' | null
  conversationId: string | null
  threadId: string | null
  replyTargetType: 'user' | 'group' | null
  replyTargetId: string | null
  senderId: string | null
  senderName: string | null
  messageType: string
  text: string | null
  status: string
  error: string | null
  createdAt: string
  receivedAt: string | null
  sentAt: string | null
}

export interface LocalConnectorHealth {
  ok: boolean
  accounts: string[]
  channels: string[]
}

export interface LocalConnectorSendInput {
  account: string
  targetType: 'user' | 'group'
  targetId: string
  text: string
  threadId?: string | null
}

export interface LocalConnectorService {
  health(baseUrl: string): Promise<LocalConnectorHealth>
  listMessages(baseUrl: string, limit?: number): Promise<LocalConnectorMessage[]>
  sendMessage(baseUrl: string, input: LocalConnectorSendInput): Promise<{ ok: boolean; messageId?: string }>
}
