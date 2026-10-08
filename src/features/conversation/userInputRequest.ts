import type { JsonObject } from '../../core/domain/codex'

export interface UserInputOption {
  label: string
  description: string
}

export interface UserInputQuestion {
  id: string
  header: string
  question: string
  options: UserInputOption[]
  isOther: boolean
  isSecret: boolean
}

export interface UserInputResponse {
  answers: Record<string, { answers: string[] }>
}

export function parseUserInputQuestions(params: JsonObject): UserInputQuestion[] {
  if (!Array.isArray(params.questions)) return []

  return params.questions.flatMap((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const candidate = value as Record<string, unknown>
    if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.question !== 'string') return []

    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return []
        const item = option as Record<string, unknown>
        if (typeof item.label !== 'string' || !item.label) return []
        return [{ label: item.label, description: typeof item.description === 'string' ? item.description : '' }]
      })
      : []

    return [{
      id: candidate.id,
      header: typeof candidate.header === 'string' && candidate.header ? candidate.header : `问题 ${index + 1}`,
      question: candidate.question,
      options,
      isOther: candidate.isOther === true,
      isSecret: candidate.isSecret === true,
    }]
  })
}

export function buildUserInputResponse(
  questions: UserInputQuestion[],
  answersByQuestionId: Record<string, string>,
): UserInputResponse | null {
  const answers: UserInputResponse['answers'] = {}
  for (const question of questions) {
    const answer = answersByQuestionId[question.id]
    if (typeof answer !== 'string' || !answer.trim()) return null
    answers[question.id] = { answers: [answer.trim()] }
  }
  return { answers }
}

export function emptyUserInputResponse(): UserInputResponse {
  return { answers: {} }
}
