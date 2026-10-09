import type { ApprovalRequest, ThreadItem, ThreadItemEntry } from '../../core/domain/codex'
import { itemText } from '../../core/domain/codex'
import { parseUserInputQuestions, type UserInputResponse } from './userInputRequest'

export const ASYNC_USER_INPUT_METHOD = 'harness/asyncUserInput'

export function asyncUserInputRequest(threadId: string, item: ThreadItem): ApprovalRequest | null {
  if (item.type !== 'agentMessage' || item.delivery !== 'async' || !item.id || !Array.isArray(item.questions)) return null
  const questions = item.questions.flatMap((question, index) => {
    if (!question || typeof question.title !== 'string' || !question.title.trim()) return []
    return [{
      id: `question-${index}`,
      header: `问题 ${index + 1}`,
      question: question.title,
      options: (question.options ?? []).filter((option) => typeof option === 'string' && option.trim())
        .map((label) => ({ label, description: '' })),
      isOther: true,
    }]
  })
  return questions.length ? { id: item.id, threadId, method: ASYNC_USER_INPUT_METHOD, params: { questions } } : null
}

export function asyncUserInputAnswer(request: ApprovalRequest, response: UserInputResponse): string {
  const questions = parseUserInputQuestions(request.params)
  const skipped = Object.keys(response.answers).length === 0
  return questions.map((question) => {
    const answer = response.answers[question.id]?.answers.join('、').trim()
    if (!skipped && !answer) throw new Error('请回答所有问题。')
    return `问题：${question.question}\n回答：${skipped ? '跳过，请继续。' : answer}`
  }).join('\n\n')
}

export function asyncUserInputAnswered(request: ApprovalRequest, laterItems: ThreadItemEntry[], pendingAnswers: string[] = []): boolean {
  const questions = parseUserInputQuestions(request.params)
  const answers = [...pendingAnswers, ...laterItems.filter(({ item }) => item.type === 'userMessage').map(({ item }) => itemText(item))]
  return answers.some((text) => questions.every((question) => text.includes(`问题：${question.question}\n回答：`)))
}
