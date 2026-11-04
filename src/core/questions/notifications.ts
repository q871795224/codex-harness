import { questionRequestIdentity } from './identity'
import { parseUserInputQuestions } from '../domain/userInput'
import { questionRevision } from './links'
import type { QuestionEvent, QuestionNotification } from './types'

export async function questionNotifications({ request, title }: QuestionEvent): Promise<QuestionNotification[]> {
  if (request.method !== 'item/tool/requestUserInput' && request.method !== 'harness/asyncUserInput') return []
  const turn = typeof request.params.turnId === 'string' ? request.params.turnId : ''
  if (!turn) return []
  return Promise.all(parseUserInputQuestions(request.params).map(async (question) => ({
    locator: { thread: request.threadId, turn, request: questionRequestIdentity(request), kind: request.method === 'harness/asyncUserInput' ? 'async' as const : 'tool' as const,
      question: question.id, revision: await questionRevision(question) },
    title,
    question: question.isSecret ? '有一个敏感问题，请在 Harness 内查看和回答。' : question.question,
    options: question.isSecret ? [] : question.options.map((option) => option.label),
  })))
}
