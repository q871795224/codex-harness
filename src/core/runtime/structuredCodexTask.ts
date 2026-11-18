import { EPHEMERAL_THREAD_DISABLED_CONFIG, type ThreadItem, type Turn, type UserInput } from '../domain/codex'
import { appServer } from './appServerClient'
import { runtime } from './bridge'

const activeThreads = new Set<string>()
export const isStructuredCodexTaskThread = (id: string) => activeThreads.has(id)

export async function runStructuredCodexTask(cwd: string, input: UserInput[], instructions: string, outputSchema: object, settings: { model?: string; effort?: string }, trigger: string, errorLabel: string): Promise<string> {
  const { config } = await appServer.readConfig(cwd)
  const response = await appServer.startThread({
    cwd, runtimeWorkspaceRoots: [cwd], ...(settings.model ? { model: settings.model } : {}), approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
    developerInstructions: instructions,
    config: { ...EPHEMERAL_THREAD_DISABLED_CONFIG, project_doc_max_bytes: 0,
      ...Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false])),
    },
  })
  const id = response.thread.id
  activeThreads.add(id)
  let turnId: string | null = null
  let unlisten: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let completed = false
  try {
    let resolve!: (text: string) => void
    let reject!: (error: Error) => void
    const result = new Promise<string>((yes, no) => { resolve = yes; reject = no })
    void result.catch(() => undefined)
    let text = ''
    unlisten = await runtime.listenEvents((event) => {
      if (event.params?.threadId !== id) return
      if (event.method === 'item/completed') {
        const item = event.params.item as ThreadItem
        if (item?.type === 'agentMessage' && item.phase !== 'commentary') text = item.text ?? ''
      }
      if (event.method === 'turn/completed') {
        const turn = event.params.turn as Turn
        if (turn.status !== 'completed') reject(new Error(turn.error?.message ?? errorLabel + '执行失败'))
        else resolve(turn.items?.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)?.text ?? text)
      }
    })
    timer = setTimeout(() => reject(new Error(errorLabel + '超时，请重试')), 60_000)
    const started = await appServer.startTurn({
      threadId: id, input,
      cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort: settings.effort || null, outputSchema, turnTrigger: trigger,
    })
    turnId = started.turn.id
    if (started.turn.status === 'completed') resolve(started.turn.items.filter((item) => item.type === 'agentMessage').at(-1)?.text ?? text)
    else if (started.turn.status === 'failed' || started.turn.status === 'interrupted') reject(new Error(started.turn.error?.message ?? errorLabel + '执行失败'))
    const resultText = await result
    completed = true
    return resultText
  } finally {
    if (timer) clearTimeout(timer)
    unlisten?.()
    if (!completed && turnId) await appServer.interruptTurn(id, turnId).catch(() => undefined)
    await appServer.unsubscribeThread(id).catch(() => undefined)
    activeThreads.delete(id)
  }
}
