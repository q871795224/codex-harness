import { Brain, LoaderCircle } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import type { MemoryService } from '../../core/memory/types'

export function MemoryButton({ service, threadId, cwd, disabled }: { service: MemoryService; threadId: string | null; cwd: string | null; disabled: boolean }) {
  const busy = useSyncExternalStore(service.subscribe, () => threadId ? service.isRunning(threadId) : false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!threadId || !cwd) return
    setError(null)
    try { await service.saveConversation({ threadId: threadId, cwd: cwd }) }
    catch (next) { setError(next instanceof Error ? next.message : String(next)) }
  }
  return <span className="project-archive-action">
    <button type="button" className="composer-icon-button" title="保存到记忆" aria-label="保存到记忆"
      disabled={disabled || busy || !threadId || !cwd}
      onClick={() => void save()}>
      {busy ? <LoaderCircle className="spin" size={15} /> : <Brain size={15} />}
    </button>
    {error && <span className="project-archive-error" role="alert">{error}</span>}
  </span>
}
