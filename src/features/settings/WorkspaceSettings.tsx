import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, LoaderCircle, Plus, RefreshCw, Tags, X } from 'lucide-react'
import type { Workspace } from '../../core/domain/codex'
import type { MemoryDomainSettings } from '../../core/memory/types'
import { runtime } from '../../core/runtime/bridge'

export function WorkspaceSettings({ workspaces, onAdd, onRemove }: {
  workspaces: Workspace[]
  onAdd: () => Promise<unknown>
  onRemove: (root: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [domains, setDomains] = useState<MemoryDomainSettings | null>(null)
  const [domainError, setDomainError] = useState<string | null>(null)
  const [domainBusy, setDomainBusy] = useState(false)
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const request = useRef(0)
  const writing = useRef(false)
  const composing = useRef(false)
  const loadDomains = useCallback(async () => {
    const version = ++request.current
    const value = await runtime.memoryDomainSettings()
    if (version === request.current) setDomains(value)
  }, [])
  useEffect(() => {
    void loadDomains().catch((next) => setDomainError(messageOf(next)))
    return () => { request.current++ }
  }, [loadDomains, workspaces])

  const mutate = async (action: () => Promise<void>, done?: () => void) => {
    if (writing.current) return
    writing.current = true
    setDomainBusy(true); setDomainError(null)
    let saved = false
    try {
      await action(); saved = true
      done?.()
      await loadDomains()
    } catch (next) {
      if (saved) setDomains(null)
      setDomainError(`${saved ? '修改已保存，但列表刷新失败：' : ''}${messageOf(next)}`)
    } finally { writing.current = false; setDomainBusy(false) }
  }
  const add = async () => {
    setAdding(true); setError(null)
    try { await onAdd() } catch (next) { setError(messageOf(next)) }
    finally { setAdding(false) }
  }
  const tags = (root: string | null, workspaceName: string) => {
    const selected = domains?.bindings.find((binding) => binding.workspaceRoot === root)?.domains ?? []
    return <div className="workspace-domain-tags" role="group" aria-label={`${workspaceName} 的领域`}>
      {!domains ? <small>正在读取领域…</small> : domains.domains.length === 0 ? <small>可在上方创建领域标签</small> : domains.domains.map((domain) => <button
        key={domain} type="button" className="workspace-domain-tag" aria-pressed={selected.includes(domain)}
        aria-label={`${workspaceName} 领域 ${domain}`} disabled={domainBusy}
        title={selected.includes(domain) ? `解除 ${domain} 关联` : `关联 ${domain}`}
        onClick={() => void mutate(() => runtime.memorySetDomainBinding(root, domain, !selected.includes(domain)))}>
        {domain}
      </button>)}
    </div>
  }

  return <div className="settings-section codex-settings">
    <section className="codex-setting-card">
      <div className="settings-section-title"><Tags size={17} /><div><h3>领域标签</h3><p>先创建领域，再给工作区选择一个或多个标签。解除关联或删除领域均保留已有记忆文件。</p></div>
        <button className="codex-refresh-button" type="button" aria-label="刷新领域" disabled={domainBusy} onClick={() => { setDomainError(null); void loadDomains().catch((next) => setDomainError(messageOf(next))) }}><RefreshCw size={14} /></button>
      </div>
      <form className="workspace-domain-create" onSubmit={(event) => {
        event.preventDefault()
        if (composing.current || !name.trim() || !domains) return
        void mutate(() => runtime.memoryCreateDomain(name.trim()), () => setName(''))
      }}>
        <input aria-label="领域名称" placeholder="例如 DNS、ADR" value={name} disabled={domainBusy || !domains}
          onChange={(event) => setName(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }} />
        <button type="submit" disabled={domainBusy || !domains || !name.trim()}><Plus size={14} />创建领域</button>
      </form>
      <div className="workspace-domain-tags" role="list" aria-label="所有领域">
        {domains?.domains.map((domain) => <span className="workspace-domain-definition" role="listitem" key={domain}>
          <span>{domain}</span>
          {deleting === domain ? <>
            <button type="button" disabled={domainBusy} aria-label={`确认删除领域 ${domain}`} onClick={() => void mutate(() => runtime.memoryDeleteDomain(domain), () => setDeleting(null))}>确认删除</button>
            <button type="button" disabled={domainBusy} aria-label={`取消删除领域 ${domain}`} onClick={() => setDeleting(null)}>取消</button>
          </> : <button type="button" disabled={domainBusy} aria-label={`删除领域 ${domain}`} title={`删除领域 ${domain} 及其关联，保留记忆文件`} onClick={() => setDeleting(domain)}><X size={12} /></button>}
        </span>)}
        {domains?.domains.length === 0 && <small>还没有领域标签</small>}
      </div>
      {domainError && <div className="plugin-settings-error" role="alert">{domainError}</div>}
    </section>
    <section className="codex-setting-card">
      <div className="settings-section-title">
        <FolderOpen size={17} />
        <div><h3>已有工作区 · {workspaces.length}</h3><p>点击领域标签关联或解除关联。移除工作区后，本地文件和历史会话会保留。</p></div>
        <button type="button" className="codex-refresh-button" aria-label="添加工作区" title="添加工作区" disabled={adding} onClick={() => void add()}>
          {adding ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
        </button>
      </div>
      <div className="codex-inventory-list" role="list" aria-label="已有工作区">
        {workspaces.map((workspace) => <div className="codex-inventory-row" role="listitem" key={workspace.root}>
          <div><strong>{workspace.name}</strong><small title={workspace.root}>{workspace.root}</small>{tags(workspace.root, workspace.name)}</div>
          <button type="button" aria-label={`移除工作区 ${workspace.name}`} onClick={() => onRemove(workspace.root)}><X size={13} />移除</button>
        </div>)}
        {workspaces.length === 0 && <div className="codex-empty">还没有工作区，点击右上角 + 添加 Git 工作区。</div>}
        <div className="codex-inventory-row"><div><strong>other · 非 Git 目录</strong><small>所有非 Git 目录共用此工作区</small>{tags(null, 'other')}</div></div>
      </div>
    </section>
    {error && <div className="plugin-settings-error" role="alert">{error}</div>}
  </div>
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
