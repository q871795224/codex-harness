import { useEffect, useRef } from 'react'
import { runtime } from '../runtime/bridge'
import { appServer } from '../runtime/appServerClient'
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
      prepareWorkspace: (workspaceRoot, access, runId) => access === 'isolated-delivery'
        ? runtime.createAgentWorktree(workspaceRoot, runId)
        : Promise.resolve(workspaceRoot),
      startThread: (workspaceRoot) => runtime.startCodexThread(workspaceRoot),
      configureThread: (threadId, settings) => appServer.updateThreadSettings({
        threadId,
        model: settings.model,
        effort: settings.effort,
        ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: settings.approvalsReviewer,
        sandboxPolicy: sandboxPolicy(settings.sandboxMode),
      }),
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

function sandboxPolicy(mode: 'danger-full-access' | 'read-only' | 'workspace-write') {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}
