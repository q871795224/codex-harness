import { runtime } from '../runtime/bridge'
import type { ProjectDocService } from './types'

const THREAD_PROJECT_BINDINGS_KEY = 'projectDocThreadBindings'

type ThreadBindings = Record<string, string>

async function readThreadBindings(): Promise<ThreadBindings> {
  const raw = await runtime.getAppState(THREAD_PROJECT_BINDINGS_KEY).catch(() => null)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const bindings: ThreadBindings = {}
      for (const [threadId, projectId] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof projectId === 'string' && projectId) bindings[threadId] = projectId
      }
      return bindings
    }
  } catch {
    // fall through to empty
  }
  return {}
}

async function writeThreadBindings(bindings: ThreadBindings): Promise<void> {
  await runtime.setAppState(THREAD_PROJECT_BINDINGS_KEY, JSON.stringify(bindings))
}

export function createProjectDocService(): ProjectDocService {
  return {
    create: (projectId, name) => runtime.projectDocCreate(projectId, name),
    list: () => runtime.projectDocList(),
    get: (projectId) => runtime.projectDocGet(projectId),
    bindWorkspace: (projectId, workspaceRoot) => runtime.projectDocBindWorkspace(projectId, workspaceRoot),
    workspaces: (projectId) => runtime.projectDocWorkspaces(projectId),
    read: (projectId) => runtime.projectDocRead(projectId),
    versions: (projectId) => runtime.projectDocVersions(projectId),
    writeSection: (input) => runtime.projectDocWriteSection(input),

    threadProject: async (threadId) => {
      const bindings = await readThreadBindings()
      return bindings[threadId] ?? null
    },
    bindThread: async (threadId, projectId) => {
      const bindings = await readThreadBindings()
      bindings[threadId] = projectId
      await writeThreadBindings(bindings)
    },
    unbindThread: async (threadId) => {
      const bindings = await readThreadBindings()
      if (!(threadId in bindings)) return
      delete bindings[threadId]
      await writeThreadBindings(bindings)
    },
  }
}
