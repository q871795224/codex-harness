import { useEffect, useRef } from 'react'
import { runtime } from '../runtime/bridge'
import { appServer } from '../runtime/appServerClient'
import { AgentRunCoordinator } from './service'
import type { AgentProvider, AgentRunService, AgentRunTransport } from './types'
import type { ThreadCodexSettings } from '../domain/codex'

export function useAgentRunService(
  selectThread: (threadId: string) => void | Promise<void>,
  startTurn: (threadId: string, prompt: string) => Promise<string>,
): AgentRunService {
  const selectThreadRef = useRef(selectThread)
  selectThreadRef.current = selectThread
  const startTurnRef = useRef(startTurn)
  startTurnRef.current = startTurn
  const claudeSettingsRef = useRef(new Map<string, ThreadCodexSettings>())
  const serviceRef = useRef<AgentRunCoordinator | null>(null)
  if (!serviceRef.current) {
    const transport: AgentRunTransport = {
      listRuns: () => runtime.listPluginRuns().then((runs) => runs.map((run) => ({
        ...run,
        provider: run.provider ?? inferProvider(run.childThreadId ?? run.parentThreadId),
      }))),
      saveRun: (run) => runtime.upsertPluginRun(run),
      prepareWorkspace: (workspaceRoot, access, runId) => access === 'isolated-delivery'
        ? runtime.createAgentWorktree(workspaceRoot, runId)
        : Promise.resolve(workspaceRoot),
      startThread: async (workspaceRoot, provider = 'codex') => {
        if (provider === 'claude') {
          const id = `claude:${crypto.randomUUID()}`
          await runtime.upsertClaudeSession({ id, providerSessionId: null, cwd: workspaceRoot, title: '快捷 Agent' })
          return id
        }
        return runtime.startCodexThread(workspaceRoot)
      },
      configureThread: (threadId, settings, provider = 'codex') => {
        if (provider === 'claude') {
          claudeSettingsRef.current.set(threadId, settings)
          return Promise.resolve()
        }
        return appServer.updateThreadSettings({
          threadId,
          model: settings.model,
          effort: settings.effort,
          ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
          approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: settings.approvalsReviewer,
          sandboxPolicy: sandboxPolicy(settings.sandboxMode),
        })
      },
      startTurn: async (threadId, prompt, provider = 'codex') => {
        if (provider === 'claude') return startClaudeAgentTurn(threadId, prompt, claudeSettingsRef.current.get(threadId))
        return startTurnRef.current(threadId, prompt)
      },
      interruptTurn: (threadId, turnId, provider = 'codex') => provider === 'claude'
        ? runtime.interruptClaudeTurn(threadId)
        : runtime.interruptCodexTurn(threadId, turnId),
      inspectThread: (threadId, provider = 'codex') => provider === 'claude'
        ? runtime.readClaudeSessionStatus(threadId).then((status) => ({
          active: status.active,
          lastTurnStatus: claudeInspectionStatus(status.lastTurnStatus),
        }))
        : runtime.inspectCodexThread(threadId),
      readLastAgentMessage: (threadId, provider = 'codex') => provider === 'claude'
        ? runtime.readLastClaudeAgentMessage(threadId)
        : runtime.readLastAgentMessage(threadId),
      openWorkspace: (workspaceRoot) => runtime.openWorkspaceApp('goland', workspaceRoot),
      deliveryContext: (workspaceRoot) => runtime.workspaceDeliveryContext(workspaceRoot),
      removeWorkspace: (workspaceRoot, runId) => runtime.removeAgentWorktree(workspaceRoot, runId),
    }
    serviceRef.current = new AgentRunCoordinator(transport, (threadId) => { void selectThreadRef.current(threadId) })
  }
  const service = serviceRef.current

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let unlistenClaude: (() => void) | undefined
    void service.initialize().catch((error) => console.error('agent run initialization failed', error))
    void runtime.listenEvents((event) => service.handleEvent(event)).then((dispose) => { unlisten = dispose })
    void runtime.listenClaudeEvents((event) => service.handleEvent(event)).then((dispose) => { unlistenClaude = dispose })
    return () => {
      unlisten?.()
      unlistenClaude?.()
    }
  }, [service])

  return service
}

async function startClaudeAgentTurn(threadId: string, prompt: string, settings?: ThreadCodexSettings): Promise<string> {
  const session = (await runtime.listClaudeSessions(true)).find((candidate) => candidate.id === threadId)
  if (!session) throw new Error('找不到快捷 Agent 的 Claude 会话')
  const turnId = `claude-agent-turn:${crypto.randomUUID()}`
  const model = settings?.model && isClaudeModel(settings.model) ? settings.model : undefined
  const permissionMode = settings?.approvalPolicy === 'never'
    ? 'bypassPermissions'
    : settings?.sandboxMode === 'read-only' ? 'plan' : 'default'
  await runtime.startClaudeTurn({
    sessionId: threadId,
    providerSessionId: session.providerSessionId,
    turnId,
    cwd: session.cwd,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
    ...(model ? { model } : {}),
    ...(settings?.effort ? { effort: settings.effort } : {}),
    permissionMode,
    maxTurns: 65_536,
  })
  return turnId
}

function isClaudeModel(model: string): boolean {
  return /^(claude[-_]|sonnet$|opus$|haiku$|auto$)/i.test(model.trim())
}

function claudeInspectionStatus(status: string | null): 'completed' | 'interrupted' | 'failed' | 'inProgress' | null {
  if (status === 'completed') return 'completed'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'failed') return 'failed'
  if (status === 'inProgress') return 'inProgress'
  return null
}

function inferProvider(threadId: string | null | undefined): AgentProvider {
  return typeof threadId === 'string' && threadId.startsWith('claude:') ? 'claude' : 'codex'
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
