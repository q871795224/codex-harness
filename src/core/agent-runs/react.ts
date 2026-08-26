import { useEffect, useRef } from 'react'
import { runtime } from '../runtime/bridge'
import { AgentRunCoordinator } from './service'
import type { AgentRunService, AgentRunTransport } from './types'

export function useAgentRunService(
  selectThread: (threadId: string) => void | Promise<void>,
  startTurn: (threadId: string, prompt: string) => Promise<string>,
): AgentRunService {
  const selectThreadRef = useRef(selectThread)
  selectThreadRef.current = selectThread
  const startTurnRef = useRef(startTurn)
  startTurnRef.current = startTurn
  const serviceRef = useRef<AgentRunCoordinator | null>(null)
  if (!serviceRef.current) {
    const transport: AgentRunTransport = {
      listRuns: () => runtime.listPluginRuns(),
      saveRun: (run) => runtime.upsertPluginRun(run),
      startThread: (workspaceRoot) => runtime.startCodexThread(workspaceRoot),
      startTurn: (threadId, prompt) => startTurnRef.current(threadId, prompt),
      interruptTurn: (threadId, turnId) => runtime.interruptCodexTurn(threadId, turnId),
      inspectThread: (threadId) => runtime.inspectCodexThread(threadId),
      readLastAgentMessage: (threadId) => runtime.readLastAgentMessage(threadId),
    }
    serviceRef.current = new AgentRunCoordinator(transport, (threadId) => { void selectThreadRef.current(threadId) })
  }
  const service = serviceRef.current

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void service.initialize().catch((error) => console.error('agent run initialization failed', error))
    void runtime.listenEvents((event) => service.handleEvent(event)).then((dispose) => { unlisten = dispose })
    return () => unlisten?.()
  }, [service])

  return service
}
