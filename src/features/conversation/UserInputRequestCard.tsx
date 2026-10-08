import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, CircleHelp, LockKeyhole } from 'lucide-react'
import type { SendShortcut } from '../../core/domain/codex'
import type { ApprovalRequest } from '../../core/domain/codex'
import { matchesSendShortcut, type ComposerKeyEvent } from './composerInput'
import {
  buildUserInputResponse,
  emptyUserInputResponse,
  parseUserInputQuestions,
  type UserInputQuestion,
  type UserInputResponse,
} from './userInputRequest'

interface UserInputRequestCardProps {
  request: ApprovalRequest
  sendShortcut: SendShortcut
  onAnswer: (request: ApprovalRequest, response: UserInputResponse) => void | Promise<void>
}

interface DraftAnswer {
  value: string
  other: boolean
}

export function UserInputRequestCard({ request, sendShortcut, onAnswer }: UserInputRequestCardProps) {
  const questions = parseUserInputQuestions(request.params)
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>({})
  const [currentIndex, setCurrentIndex] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const otherInputRef = useRef<HTMLInputElement>(null)
  const previousIndex = useRef(currentIndex)
  const firstRender = useRef(true)
  const index = Math.min(currentIndex, Math.max(questions.length - 1, 0))
  const question = questions[index]

  useEffect(() => {
    if (firstRender.current || previousIndex.current !== currentIndex) cardRef.current?.focus({ preventScroll: true })
    firstRender.current = false
    previousIndex.current = currentIndex
  }, [currentIndex])

  const values: Record<string, string> = {}
  for (const item of questions) {
    const answer = answers[item.id]
    if (!answer) continue
    if (item.options.length > 0 && !answer.other) {
      if (item.options.some((option) => option.label === answer.value)) values[item.id] = answer.value
    } else if (answer.value.trim()) {
      values[item.id] = answer.value
    }
  }
  const response = buildUserInputResponse(questions, values)

  const send = async (result: UserInputResponse) => {
    if (submitting) return
    setSubmitting(true)
    try {
      await onAnswer(request, result)
    } finally {
      setSubmitting(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (response) void send(response)
  }

  const updateAnswer = (questionId: string, answer: DraftAnswer) => {
    setAnswers((current) => ({ ...current, [questionId]: answer }))
  }

  const chooseOption = (selectedQuestion: UserInputQuestion, optionIndex: number) => {
    const option = selectedQuestion.options[optionIndex]
    if (!option) return
    updateAnswer(selectedQuestion.id, { value: option.label, other: false })
    if (index < questions.length - 1) setCurrentIndex(index + 1)
  }

  const chooseOther = (selectedQuestion: UserInputQuestion) => {
    const currentAnswer = answers[selectedQuestion.id]
    updateAnswer(selectedQuestion.id, { value: currentAnswer?.other ? currentAnswer.value : '', other: true })
    requestAnimationFrame(() => otherInputRef.current?.focus())
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const shortcutEvent: ComposerKeyEvent = {
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    }
    if (matchesSendShortcut(shortcutEvent, sendShortcut)) {
      event.preventDefault()
      if (response) void send(response)
      return
    }

    const textEntry = isTextEntryTarget(event.target)
    if (event.key === 'Enter' && textEntry && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      return
    }
    if (!question || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (event.key === 'ArrowLeft' && index > 0) {
      if (textEntry && !isInputAtArrowBoundary(event.target, 'ArrowLeft')) return
      event.preventDefault()
      setCurrentIndex(index - 1)
      return
    }
    if (event.key === 'ArrowRight' && index < questions.length - 1) {
      if (textEntry && !isInputAtArrowBoundary(event.target, 'ArrowRight')) return
      event.preventDefault()
      setCurrentIndex(index + 1)
      return
    }
    if (textEntry) return
    if (/^[1-9]$/.test(event.key)) {
      const choiceIndex = Number(event.key) - 1
      if (choiceIndex < question.options.length) {
        event.preventDefault()
        chooseOption(question, choiceIndex)
      } else if (question.isOther && choiceIndex === question.options.length) {
        event.preventDefault()
        chooseOther(question)
      }
    }
  }

  const shortcutLabel = sendShortcut === 'enter' ? 'Enter' : '⌘ / Ctrl + Enter'

  return (
    <article
      ref={cardRef}
      className="approval-card user-input-card"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      aria-label={question ? `问题 ${index + 1} / ${questions.length}` : 'Codex 提问'}
    >
      <div className="approval-icon user-input-icon"><CircleHelp size={17} /></div>
      <div className="approval-content user-input-content">
        {questions.length === 0 ? (
          <>
            <h3>无法读取这个问题</h3>
            <p className="user-input-unavailable">可以跳过后让 Codex 继续。</p>
            <div className="approval-actions user-input-actions">
              <button type="button" className="deny" disabled={submitting} onClick={() => void send(emptyUserInputResponse())}>{submitting ? '跳过中…' : '跳过'}</button>
            </div>
          </>
        ) : question ? (
          <>
            <div className="user-input-card-head">
              <div className="user-input-question-title">
                <div className="user-input-question-meta">
                  <span>{question.header}</span>
                  {question.isSecret && <span className="user-input-secret"><LockKeyhole size={11} />敏感回答</span>}
                </div>
                <h3>{question.question}</h3>
              </div>
              <div className="user-input-question-nav" aria-label="问题导航">
                <button type="button" aria-label="上一题" title="上一题（←）" disabled={index === 0 || submitting} onClick={() => setCurrentIndex(index - 1)}>
                  <ChevronLeft size={15} />
                </button>
                <span aria-live="polite">{index + 1} / {questions.length}</span>
                <button type="button" aria-label="下一题" title="下一题（→）" disabled={index === questions.length - 1 || submitting} onClick={() => setCurrentIndex(index + 1)}>
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
            <form onSubmit={submit}>
              <QuestionField
                question={question}
                index={index}
                answer={answers[question.id]}
                disabled={submitting}
                otherInputRef={otherInputRef}
                onChange={(answer) => updateAnswer(question.id, answer)}
                onChooseOption={(optionIndex) => chooseOption(question, optionIndex)}
                onChooseOther={() => chooseOther(question)}
              />
              <div className="approval-actions user-input-actions">
                <button type="button" className="deny" disabled={submitting} onClick={() => void send(emptyUserInputResponse())}>跳过</button>
                <span className="user-input-shortcut-hint">{shortcutLabel} 提交</span>
                <button type="submit" className="approve" disabled={!response || submitting}>
                  {submitting ? '提交中…' : '提交回答'}
                </button>
              </div>
            </form>
          </>
        ) : null}
      </div>
    </article>
  )
}

function QuestionField({
  question,
  index,
  answer,
  disabled,
  otherInputRef,
  onChange,
  onChooseOption,
  onChooseOther,
}: {
  question: UserInputQuestion
  index: number
  answer?: DraftAnswer
  disabled: boolean
  otherInputRef: RefObject<HTMLInputElement>
  onChange: (answer: DraftAnswer) => void
  onChooseOption: (optionIndex: number) => void
  onChooseOther: () => void
}) {
  const fieldId = `user-input-${index}-${question.id}`
  const freeformOnly = question.options.length === 0

  return (
    <fieldset className="user-input-question">
      <legend className="user-input-field-legend">{question.header}回答</legend>
      {freeformOnly ? (
        <input
          id={fieldId}
          className="user-input-freeform"
          type={question.isSecret ? 'password' : 'text'}
          autoComplete={question.isSecret ? 'new-password' : 'off'}
          aria-label={`${question.header}回答`}
          value={answer?.value ?? ''}
          disabled={disabled}
          onChange={(event) => onChange({ value: event.target.value, other: true })}
        />
      ) : (
        <div className="user-input-options" role="group" aria-label={`${question.header}选项`}>
          {question.options.map((option, optionIndex) => (
            <button
              key={option.label}
              type="button"
              className={`user-input-option${answer?.value === option.label && !answer.other ? ' selected' : ''}`}
              aria-pressed={answer?.value === option.label && !answer.other}
              disabled={disabled}
              onClick={() => onChooseOption(optionIndex)}
            >
              <span className="user-input-option-number" aria-hidden="true">{optionIndex < 9 ? optionIndex + 1 : ''}</span>
              <span className="user-input-option-copy">
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </button>
          ))}
          {question.isOther && (
            <div className={`user-input-option user-input-other${answer?.other ? ' selected' : ''}`}>
              <span className="user-input-option-number" aria-hidden="true">{question.options.length < 9 ? question.options.length + 1 : ''}</span>
              <label className="user-input-other-label" htmlFor={`${fieldId}-other`}>其他</label>
              <input
                ref={otherInputRef}
                id={`${fieldId}-other`}
                className="user-input-other-field"
                type={question.isSecret ? 'password' : 'text'}
                autoComplete={question.isSecret ? 'new-password' : 'off'}
                aria-label={`${question.header}的其他回答`}
                placeholder="填写自己的答案"
                value={answer?.other ? answer.value : ''}
                disabled={disabled}
                onFocus={onChooseOther}
                onChange={(event) => onChange({ value: event.target.value, other: true })}
              />
            </div>
          )}
        </div>
      )}
    </fieldset>
  )
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

function isInputAtArrowBoundary(target: EventTarget | null, key: 'ArrowLeft' | 'ArrowRight'): boolean {
  if (!(target instanceof HTMLInputElement)) return false
  if (key === 'ArrowLeft') return target.selectionStart === 0 && target.selectionEnd === 0
  return target.selectionStart === target.value.length && target.selectionEnd === target.value.length
}
