import { runtime } from '../runtime/bridge'
import type { ProjectDocService } from './types'

export function createProjectDocService(): ProjectDocService {
  const bindingListeners = new Set<() => void>()
  const notifyBindings = () => {
    for (const listener of [...bindingListeners]) listener()
  }
  return {
    create: (projectId, name) => runtime.projectDocCreate(projectId, name),
    list: () => runtime.projectDocList(),
    get: (projectId) => runtime.projectDocGet(projectId),
    rename: (projectId, name) => runtime.projectDocRename(projectId, name),
    archive: (projectId) => runtime.projectDocArchive(projectId),
    bindWorkspace: (projectId, workspaceRoot) => runtime.projectDocBindWorkspace(projectId, workspaceRoot),
    workspaces: (projectId) => runtime.projectDocWorkspaces(projectId),
    read: (projectId) => runtime.projectDocRead(projectId),
    versions: (projectId) => runtime.projectDocVersions(projectId),
    writeSection: (input) => runtime.projectDocWriteSection(input),
    writeDocument: (input) => runtime.projectDocWriteDocument(input),
    listProposals: (projectId) => runtime.projectDocListProposals(projectId),
    approveProposal: (proposalId) => runtime.projectDocApproveProposal(proposalId),
    rejectProposal: (proposalId) => runtime.projectDocRejectProposal(proposalId),
    ensureServer: () => runtime.projectDocEnsureServer(),

    threadProject: async (threadId) => (await runtime.projectDocThreadBinding(threadId))?.projectId ?? null,
    threadBinding: (threadId) => runtime.projectDocThreadBinding(threadId),
    bindThread: async (threadId, projectId) => {
      await runtime.projectDocBindThread(threadId, projectId)
      notifyBindings()
    },
    lockThreadBinding: async (threadId) => {
      await runtime.projectDocLockThreadBinding(threadId)
      notifyBindings()
    },
    unbindThread: async (threadId) => {
      await runtime.projectDocUnbindThread(threadId)
      notifyBindings()
    },
    subscribeBindings: (listener) => {
      bindingListeners.add(listener)
      return () => { bindingListeners.delete(listener) }
    },
  }
}
