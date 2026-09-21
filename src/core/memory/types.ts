export interface MemoryCandidate {
  title: string
  kind: 'preference' | 'fact' | 'experience' | 'reference'
  scope: string
  content: string
  applicability: string
  evidence: string
  sourceTurnIds: string[]
  relatedWorkspaces: string[]
}

export interface MemoryCatalog {
  currentWorkspace: string
  workspaces: string[]
  domains: string[]
}

export interface MemorySaveInput {
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
