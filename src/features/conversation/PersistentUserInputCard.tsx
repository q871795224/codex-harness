import { questionRequestIdentity } from '../../core/questions/identity'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ApprovalRequest, SendShortcut } from '../../core/domain/codex'
import { parseUserInputQuestions, type UserInputResponse } from './userInputRequest'
import { questionDraftKey, questionDrafts } from './questionDraftStore'
import { questionRevision } from '../../core/questions/links'
import type { QuestionNavigation } from '../../core/questions/types'
import { runtime } from '../../core/runtime/bridge'
import { UserInputRequestCard } from './UserInputRequestCard'

export function matchesQuestionNavigation(request: ApprovalRequest, navigation?: QuestionNavigation | null): boolean {
  const target = navigation?.locator
  return Boolean(target && target.thread === request.threadId && target.request === questionRequestIdentity(request)
    && target.turn === request.params.turnId && target.kind === (request.method === 'harness/asyncUserInput' ? 'async' : 'tool'))
}

export function PersistentUserInputCard({ request, navigation, sendShortcut, onAnswer }: {
  request: ApprovalRequest
  navigation?: QuestionNavigation | null
  sendShortcut: SendShortcut
  onAnswer: (request: ApprovalRequest, response: UserInputResponse) => void | Promise<void>
}) {
  const key = questionDraftKey(request)
  const answers = useSyncExternalStore(questionDrafts.subscribe, () => questionDrafts.snapshot(key))
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const questions = parseUserInputQuestions(request.params)
  const secrets = new Set(questions.filter(q => q.isSecret).map(q => q.id))
  const targeted = matchesQuestionNavigation(request, navigation) ? navigation : null
  const paramsSignature = JSON.stringify(request.params)
  useEffect(() => {
    let cancelled = false
    void questionDrafts.load(key, secrets).then(() => { if (!cancelled) setLoadedKey(key) })
    return () => { cancelled = true }
  }, [key])
  useEffect(() => {
    if (loadedKey !== key || !targeted || questionDrafts.navigationApplied(key, targeted.sequence)) return
    let cancelled = false
    void (async () => {
      const target = targeted.locator
      let latestQuestions = questions
      if (target.kind === 'tool') {
        const latest = await runtime.pendingUserInput(target)
        if (cancelled) return
        if (!latest) { setMessage('当前没有这个待回答请求，请查看会话中的实际状态。'); return }
        latestQuestions = parseUserInputQuestions(latest.params)
      }
      const question = latestQuestions.find(q => q.id === target.question)
      if (!question || await questionRevision(question) !== target.revision) {
        if (!cancelled) { setMessage('问题或选项已更新，请在当前表单重新选择。'); questionDrafts.markNavigationApplied(key, targeted.sequence) }
        return
      }
      if (cancelled) return
      if (target.option !== undefined) {
        const option = question.options[target.option]
        if (!option || question.isSecret) { setMessage('这个选项当前不可用，请在表单内填写。'); questionDrafts.markNavigationApplied(key, targeted.sequence); return }
        // Claim before emitting the draft change: remounting the conversation
        // must not append the same clicked answer again.
        questionDrafts.markNavigationApplied(key, targeted.sequence)
        await questionDrafts.append(key, question.id, option.label, secrets)
        if (cancelled) return
        setMessage('答案已填入问题表单，请检查后手动提交。')
      } else setMessage('已定位问题，请在表单内回答。')
      questionDrafts.markNavigationApplied(key, targeted.sequence)
    })().catch(() => { if (!cancelled) setMessage('暂时无法核对问题，请在会话内查看。') })
    return () => { cancelled = true }
  }, [loadedKey, key, targeted, paramsSignature])
  if (loadedKey !== key) return <p role="status">正在恢复问题草稿…</p>
  return <>
    {targeted && message && <p role="status">{message}</p>}
    <UserInputRequestCard request={request} sendShortcut={sendShortcut} draftAnswers={answers}
      navigation={targeted} onDraftAnswer={(id, answer) => questionDrafts.update(key, id, answer, secrets)}
      onAnswer={async (request, response) => { await onAnswer(request, response); await questionDrafts.clear(key) }} />
  </>
}
