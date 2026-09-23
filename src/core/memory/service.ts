import { loadMemorySettings, DEFAULT_MEMORY_SETTINGS, type MemorySettings } from './settings'
import { DEFAULT_BACKGROUND_MODEL, EPHEMERAL_THREAD_DISABLED_CONFIG, textInput, type AppServerEvent, type ThreadItem, type Turn } from '../domain/codex'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import type { NotificationService } from '../notifications/store'
import { extractionPrompt, MEMORY_OUTPUT_SCHEMA, memoryTranscript, parseMemories } from './extraction'
import type { MemoryService, SavedMemory } from './types'

export async function loadMemoryTurns(threadId: string, maxTurns = 0): Promise<Turn[]> {
  const turns = new Map<string, Turn>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const page = await appServer.listTurns({ threadId, cursor, limit: maxTurns > 0 ? Math.min(20, maxTurns - turns.size) : 20, sortDirection: maxTurns > 0 ? 'desc' : 'asc', itemsView: 'full' })
    for (const turn of page.data) turns.set(turn.id, turn)
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('会话历史分页未前进，请重试')
    if (cursor) cursors.add(cursor)
  } while (cursor && (maxTurns === 0 || turns.size < maxTurns))
  const result = [...turns.values()]
  return maxTurns > 0 ? result.slice(0, maxTurns).reverse() : result
}

export async function extractMemoryJson(cwd: string, prompt: string, model: string, window: number, percent: number, config: Record<string, unknown>, settings: MemorySettings = DEFAULT_MEMORY_SETTINGS): Promise<string> {
  const response = await appServer.startThread({
    cwd, runtimeWorkspaceRoots: [cwd], model, approvalPolicy: 'never', sandbox: 'read-only',
    ephemeral: true, developerInstructions: settings.prompt,
    config: {
      ...EPHEMERAL_THREAD_DISABLED_CONFIG,
      ...Object.fromEntries(Object.keys((config.mcp_servers as object | undefined) ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false])),
      'model_context_window': window, 'model_effective_context_window_percent': percent,
      'project_doc_max_bytes': 0,
    },
  })
  const threadId = response.thread.id
  let turnId: string | null = null
  let unlisten: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let complete = false
  try {
    let resolve!: (text: string) => void
    let reject!: (error: Error) => void
    const result = new Promise<string>((yes, no) => { resolve = yes; reject = no })
    void result.catch(() => undefined)
    let text = ''
    unlisten = await runtime.listenEvents((event: AppServerEvent) => {
      const params = event.params ?? {}
      if (params.threadId !== threadId) return
      if (event.method === 'item/completed') {
        const item = params.item as ThreadItem | undefined
        if (item?.type === 'agentMessage' && item.phase !== 'commentary') text = item.text ?? ''
      }
      if (event.method === 'turn/completed') {
        const turn = params.turn as Turn
        if (turn.status !== 'completed') reject(new Error(turn.error?.message ?? '记忆提炼未完成'))
        else {
          const final = turn.items?.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)
          resolve(final?.text ?? text)
        }
      }
    })
    timer = setTimeout(() => reject(new Error('记忆提炼超时，请重试')), 5 * 60 * 1000)
    const started = await appServer.startTurn({
      threadId, input: [textInput(prompt)], cwd, runtimeWorkspaceRoots: [cwd],
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort: settings.effort || null, outputSchema: MEMORY_OUTPUT_SCHEMA, turnTrigger: 'memory-save',
    })
    turnId = started.turn.id
    if (started.turn.status === 'completed') {
      resolve(started.turn.items.filter((item) => item.type === 'agentMessage').at(-1)?.text ?? text)
    } else if (started.turn.status === 'failed' || started.turn.status === 'interrupted') {
      reject(new Error(started.turn.error?.message ?? '记忆提炼未完成'))
    }
    const output = await result
    complete = true
    return output
  } finally {
    if (timer) clearTimeout(timer)
    unlisten?.()
    if (!complete && turnId) await appServer.interruptTurn(threadId, turnId).catch(() => undefined)
    await appServer.unsubscribeThread(threadId).catch(() => undefined)
  }
}

export function createMemoryService(notifications: NotificationService): MemoryService {
  const running = new Set<string>()
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())
  return {
    isRunning: (threadId) => running.has(threadId),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    async saveConversation({ threadId, cwd }): Promise<SavedMemory[]> {
      if (running.has(threadId)) throw new Error('当前会话正在保存记忆')
      running.add(threadId)
      emit()
      const notice = { source: '记忆', threadId, workspaceRoot: cwd }
      const id = notifications.publish({ ...notice, level: 'info', title: '正在整理记忆', state: 'running' })
      try {
        const settings = await loadMemorySettings()
        const [turns, catalog, response] = await Promise.all([
          loadMemoryTurns(threadId, settings.maxTurns), runtime.memoryCatalog(cwd), appServer.readConfig(cwd),
        ])
        const transcript = memoryTranscript(turns)
        if (!transcript) throw new Error('当前会话没有可提炼的上下文')
        const config = response.config as unknown as Record<string, unknown>
        const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
        const contextWindow = settings.contextWindowTokens || (positive(config.model_context_window) ? Math.floor(config.model_context_window) : 150_000)
        const percent = positive(config.model_effective_context_window_percent) ? Math.min(100, config.model_effective_context_window_percent) : 95
        const { prompt, truncated } = extractionPrompt(transcript, catalog, Math.floor(contextWindow * percent / 100), settings.prompt, settings.budgetPercent)
        const model = settings.model || (typeof config.model === 'string' && config.model ? config.model : DEFAULT_BACKGROUND_MODEL)
        const output = await extractMemoryJson(cwd, prompt, model, contextWindow, percent, config, settings)
        const memories = parseMemories(output)
        const saved = memories.length ? await runtime.memorySave({ threadId, cwd, sourceWorkspace: catalog.currentWorkspace, sourceTurnIds: turns.map((turn) => turn.id), memories }) : []
        notifications.publish({
          ...notice, id, level: 'info', state: 'done',
          title: saved.length ? `已保存 ${saved.length} 条记忆` : '本次没有值得保存的记忆',
          message: [truncated ? '上下文超出预算，已保留首尾。' : '', ...saved.map((memory) => `${memory.title} · ${memory.scope}\n${memory.path}`)].filter(Boolean).join('\n'),
        })
        return saved
      } catch (error) {
        notifications.publish({ ...notice, id, level: 'error', state: 'done', title: '记忆保存未完成', message: error instanceof Error ? error.message : String(error) })
        throw error
      } finally {
        running.delete(threadId)
        emit()
      }
    },
  }
}
