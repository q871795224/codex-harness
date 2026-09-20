import { useState } from 'react'
import { FolderOpen, LoaderCircle, Plus, X } from 'lucide-react'
import type { Workspace } from '../../core/domain/codex'

export function WorkspaceSettings({ workspaces, onAdd, onRemove }: {
  workspaces: Workspace[]
  onAdd: () => Promise<unknown>
  onRemove: (root: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    setAdding(true)
    setError(null)
    try {
      await onAdd()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setAdding(false)
    }
  }

  return <div className="settings-section codex-settings">
    <section className="codex-setting-card">
      <div className="settings-section-title">
        <FolderOpen size={17} />
        <div><h3>已有工作区 · {workspaces.length}</h3><p>移除后可重新添加，本地文件和历史会话会保留。</p></div>
        <button type="button" className="codex-refresh-button" aria-label="添加工作区" title="添加工作区" disabled={adding} onClick={() => void add()}>
          {adding ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
        </button>
      </div>
      <div className="codex-inventory-list" role="list" aria-label="已有工作区">
        {workspaces.map((workspace) => <div className="codex-inventory-row" role="listitem" key={workspace.root}>
          <div><strong>{workspace.name}</strong><small title={workspace.root}>{workspace.root}</small></div>
          <button type="button" aria-label={`移除工作区 ${workspace.name}`} onClick={() => onRemove(workspace.root)}><X size={13} />移除</button>
        </div>)}
        {workspaces.length === 0 && <div className="codex-empty">还没有工作区，点击右上角 + 添加 Git 工作区。</div>}
      </div>
    </section>
    {error && <div className="plugin-settings-error" role="alert">{error}</div>}
  </div>
}
