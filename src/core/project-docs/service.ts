import { runtime } from '../runtime/bridge'
import type { ProjectDocService, ThreadProjectBinding } from './types'

const THREAD_PROJECT_BINDINGS_KEY = 'projectDocThreadBindings'

type ThreadBindings = Record<string, ThreadProjectBinding>

/**
 * 解析存储的绑定记录，向后兼容两种历史格式：
 * - 纯字符串 projectId（最老格式，即绑即锁）→ locked
 * - { projectId, phase }（当前格式）
 */
function normalizeBinding(raw: unknown): ThreadProjectBinding | null {
  if (typeof raw === 'string' && raw) return { projectId: raw, phase: 'locked' }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = raw as Record<string, unknown>
    if (typeof candidate.projectId === 'string' && candidate.projectId) {
      return { projectId: candidate.projectId, phase: candidate.phase === 'pending' ? 'pending' : 'locked' }
    }
  }
  return null
}

async function readThreadBindings(): Promise<ThreadBindings> {
  const raw = await runtime.getAppState(THREAD_PROJECT_BINDINGS_KEY).catch(() => null)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const bindings: ThreadBindings = {}
      for (const [threadId, value] of Object.entries(parsed as Record<string, unknown>)) {
        const binding = normalizeBinding(value)
        if (binding) bindings[threadId] = binding
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

    threadProject: async (threadId) => {
      const bindings = await readThreadBindings()
      return bindings[threadId]?.projectId ?? null
    },
    threadBinding: async (threadId) => {
      const bindings = await readThreadBindings()
      return bindings[threadId] ?? null
    },
    bindThread: async (threadId, projectId) => {
      const bindings = await readThreadBindings()
      bindings[threadId] = { projectId, phase: 'pending' }
      await writeThreadBindings(bindings)
      notifyBindings()
    },
    lockThreadBinding: async (threadId) => {
      const bindings = await readThreadBindings()
      const binding = bindings[threadId]
      if (!binding || binding.phase === 'locked') return
      bindings[threadId] = { ...binding, phase: 'locked' }
      await writeThreadBindings(bindings)
      notifyBindings()
    },
    unbindThread: async (threadId) => {
      const bindings = await readThreadBindings()
      if (!(threadId in bindings)) return
      delete bindings[threadId]
      await writeThreadBindings(bindings)
      notifyBindings()
    },
    subscribeBindings: (listener) => {
      bindingListeners.add(listener)
      return () => { bindingListeners.delete(listener) }
    },
  }
}
