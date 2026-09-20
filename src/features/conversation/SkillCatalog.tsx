import { createContext, useEffect, useState } from 'react'
import type { CodexSkill } from '../../core/domain/codex'
import { appServer } from '../../core/runtime/appServerClient'

export const SkillCatalogContext = createContext<readonly CodexSkill[]>([])

export function useSkillCatalog(cwd: string, enabled: boolean): readonly CodexSkill[] {
  const [catalog, setCatalog] = useState<{ cwd: string; skills: CodexSkill[] } | null>(null)
  useEffect(() => {
    if (!enabled || !cwd) return
    let cancelled = false
    void appServer.listSkills(cwd).then((response) => {
      if (!cancelled) setCatalog({ cwd, skills: response.data.flatMap((entry) => entry.skills) })
    }).catch(() => { /* Read evidence remains visible even when the catalog is unavailable. */ })
    return () => { cancelled = true }
  }, [cwd, enabled])
  return catalog?.cwd === cwd ? catalog.skills : []
}
