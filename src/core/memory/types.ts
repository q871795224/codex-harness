export interface MemoryDraft {
  title: string
  kind: 'preference' | 'fact' | 'experience' | 'reference'
  scope: string
  content: string
  applicability: string
  evidence: string
}

/** Harness-owned provenance for the selected extraction range, not per-item evidence. */
export interface MemoryCandidate extends MemoryDraft {
  sourceTurnIds: string[]
}

export interface MemoryCatalog {
  currentWorkspace: string
  workspaces: string[]
  domains: string[]
}

export interface MemorySaveInput {
  sourceWorkspace: string
  threadId: string
  cwd: string
  sourceTurnIds: string[]
  memories: MemoryCandidate[]
}

export interface SavedMemory {
  id: string
  title: string
  scope: string
  path: string
}

export interface MemoryService {
  saveConversation(input: { threadId: string; cwd: string }): Promise<SavedMemory[]>
  isRunning(threadId: string): boolean
  subscribe(listener: () => void): () => void
}

export interface MemoryDomainSettings {
  domains: string[]
  bindings: Array<{ workspaceName: string; workspaceRoot: string | null; domains: string[] }>
}
