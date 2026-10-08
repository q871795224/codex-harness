import { describe, expect, it } from 'vitest'
import { buildUserInputResponse, emptyUserInputResponse, parseUserInputQuestions } from './userInputRequest'

describe('request_user_input payloads', () => {
  it('parses question prompts, selectable options, other, and secret flags', () => {
    expect(parseUserInputQuestions({
      questions: [
        {
          id: 'approach',
          header: '方案',
          question: '选哪种方案？',
          options: [{ label: '轻量', description: '改动少' }],
          isOther: true,
        },
        { id: 'token', header: '凭据', question: '输入临时 Token', isSecret: true },
        { id: '', question: '忽略缺少 id 的问题' },
      ],
    })).toEqual([
      {
        id: 'approach',
        header: '方案',
        question: '选哪种方案？',
        options: [{ label: '轻量', description: '改动少' }],
        isOther: true,
        isSecret: false,
      },
      {
        id: 'token',
        header: '凭据',
        question: '输入临时 Token',
        options: [],
        isOther: false,
        isSecret: true,
      },
    ])
  })

  it('maps each question id to one trimmed answer', () => {
    const questions = parseUserInputQuestions({ questions: [
      { id: 'approach', question: '选方案？' },
      { id: 'scope', question: '限定范围？' },
    ] })

    expect(buildUserInputResponse(questions, { approach: ' A ', scope: 'src/' })).toEqual({
      answers: {
        approach: { answers: ['A'] },
        scope: { answers: ['src/'] },
      },
    })
  })

  it('requires every question to have a non-blank answer', () => {
    const questions = parseUserInputQuestions({ questions: [
      { id: 'approach', question: '选方案？' },
      { id: 'scope', question: '限定范围？' },
    ] })
    expect(buildUserInputResponse(questions, { approach: 'A', scope: '  ' })).toBeNull()
  })

  it('can dismiss a request without inventing an answer', () => {
    expect(emptyUserInputResponse()).toEqual({ answers: {} })
  })
})
