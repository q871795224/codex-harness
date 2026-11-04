import type { ApprovalRequest } from '../domain/codex'

export interface QuestionEvent { request: ApprovalRequest; title: string }
export interface QuestionLocator {
  thread: string
  turn: string
  request: string
  kind: 'tool' | 'async'
  question: string
  revision: string
  option?: number
}
export interface QuestionNavigation { locator: QuestionLocator; sequence: number }
export interface QuestionNotification {
  locator: QuestionLocator
  title: string
  question: string
  options: string[]
}
export interface QuestionNotificationService {
  send(baseUrl: string, account: string, targetId: string, input: QuestionNotification): Promise<void>
}
