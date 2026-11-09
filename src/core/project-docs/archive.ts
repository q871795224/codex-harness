import { EPHEMERAL_THREAD_DISABLED_CONFIG, textInput, type ThreadItem, type Turn } from '../domain/codex'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import type { ProjectArchiveInput } from './types'

/** The draft is read from live events: ephemeral threads have no persisted rollout. */
export async function generateProjectArchive(input: ProjectArchiveInput): Promise<string> {
  const { workspaceRoot: cwd, prompt, model, effort } = input
  const response = await appServer.startThread({
    cwd, runtimeWorkspaceRoots: [cwd], model,
    approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
    config: { ...EPHEMERAL_THREAD_DISABLED_CONFIG, project_doc_max_bytes: 0 },
  })
  const threadId = response.thread.id
  let turnId: string | null = null
  let unlisten: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let terminal = false
  try {
    let resolve!: (text: string) => void
    let reject!: (error: Error) => void
    const result = new Promise<string>((yes, no) => { resolve = yes; reject = no })
    void result.catch(() => undefined)
    let text = ''
    const finish = (turn: Turn) => {
      if (turn.status === 'inProgress') return
      terminal = true
      if (turn.status !== 'completed') reject(new Error(turn.error?.message ?? '项目归档未完成。'))
      else {
        const final = turn.items?.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)
        resolve(final?.text ?? text)
      }
    }
    unlisten = await runtime.listenEvents((event) => {
      const params = event.params ?? {}
      if (params.threadId !== threadId) return
      if (event.method === 'item/completed') {
        const item = params.item as ThreadItem | undefined
        if (item?.type === 'agentMessage' && item.phase !== 'commentary') text = item.text ?? ''
      }
      if (event.method === 'turn/completed') finish(params.turn as Turn)
    })
    timer = setTimeout(() => reject(new Error('归档超时（5 分钟未完成）。')), 5 * 60 * 1000)
    const started = await appServer.startTurn({
      threadId, clientUserMessageId: crypto.randomUUID(), input: [textInput(prompt)],
      cwd, runtimeWorkspaceRoots: [cwd], effort,
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      turnTrigger: 'quick-agent',
    })
    turnId = started.turn.id
    finish(started.turn)
    return await result
  } finally {
    if (timer) clearTimeout(timer)
    unlisten?.()
    if (!terminal && turnId) await appServer.interruptTurn(threadId, turnId).catch(() => undefined)
    await appServer.unsubscribeThread(threadId).catch(() => undefined)
  }
}
