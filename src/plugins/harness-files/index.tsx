import { useCallback, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react'
import { Markdown } from '../../features/markdown/Markdown'
import type { HarnessFileNode, HarnessFileTree, HarnessFilesService } from '../../core/harness-files/types'
import type { ConversationTabProps, HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

export const harnessFilesPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.harness-files',
    name: 'Harness 文件',
    description: '按会话类型管理 Codex / Claude 指令文件与 Harness 工作目录。',
    version: '1.1.0',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global'],
    permissions: ['filesystem:harness-files'],
  },
  activate(ctx) {
    const files = ctx.services.get<HarnessFilesService>('harness.files')
    ctx.slots.conversationTabs.register({
      id: 'harness-files',
      label: 'Harness',
      order: 30,
      icon: FolderOpen,
      render: (props) => <HarnessFilesTab files={files} context={props} />,
    })
  },
}

export const harnessFilesDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.harness-files:default',
  pluginId: harnessFilesPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

export function HarnessFilesTab({ files, context }: { files: HarnessFilesService; context: ConversationTabProps }) {
  const cwd = context.threadCwd
  const provider = context.provider ?? 'codex'
  const workspaceName = context.workspaces.find((workspace) => workspace.root === context.workspaceRoot)?.name
    ?? (context.workspaceRoot ?? cwd)?.split('/').filter(Boolean).pop() ?? '工作区'
  const providerLabel = provider === 'claude' ? 'Claude' : 'Codex'
  const configurationKey = files.configurationKey(provider)
  const [revision, setRevision] = useState(0)
  const [tree, setTree] = useState<HarnessFileTree | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState(false)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const nodes = useMemo(() => tree ? flattenNodes(tree.roots) : [], [tree])
  const selected = nodes.find((node) => node.path === selectedPath) ?? null
  const dirty = selected?.kind === 'file' && content !== savedContent

  const refresh = useCallback(async (preferredPath?: string | null) => {
    if (!cwd) {
      setTree(null)
      setSelectedPath(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = organizeTree(await files.list(cwd, provider))
      const flattened = flattenNodes(next.roots)
      const preferred = preferredPath ?? selectedPath
      const nextSelected = flattened.find((node) => node.path === preferred)
        ?? flattened.find((node) => node.kind === 'file' && node.exists)
        ?? flattened.find((node) => node.kind === 'file')
        ?? null
      setTree(next)
      setRevision((value) => value + 1)
      setSelectedPath(nextSelected?.path ?? null)
      setExpanded((current) => {
        if (current.size > 0) return current
        return new Set(flattened.filter((node) => node.kind === 'directory').map((node) => node.path))
      })
    } catch (nextError) {
      setError(messageOf(nextError))
      setTree(null)
    } finally {
      setLoading(false)
    }
  }, [cwd, files, provider, selectedPath])

  useEffect(() => {
    setExpanded(new Set())
    setSelectedPath(null)
    setContent('')
    setSavedContent('')
    setNotice(null)
    void refresh(null)
  }, [cwd, configurationKey, provider]) // Config changes alter fallback names and the effective instruction chain.

  useEffect(() => {
    if (!cwd || !selected || selected.kind !== 'file') {
      setContent('')
      setSavedContent('')
      return
    }
    if (!selected.exists) {
      setReadFailed(false)
      setReading(false)
      setContent('')
      setSavedContent('')
      setError(null)
      return
    }
    let disposed = false
    setReading(true)
    setReadFailed(true)
    setError(null)
    void files.read(cwd, selected.path, provider)
      .then((value) => {
        if (disposed) return
        setReadFailed(false)
        setContent(value)
        setSavedContent(value)
      })
      .catch((nextError) => { if (!disposed) setError(messageOf(nextError)) })
      .finally(() => { if (!disposed) setReading(false) })
    return () => { disposed = true }
  }, [cwd, files, provider, selected?.exists, selected?.kind, selected?.path, revision])

  const selectNode = (node: HarnessFileNode) => {
    if (node.path !== selectedPath && dirty && !window.confirm('当前文件有未保存的修改，确定切换吗？')) return
    if (node.kind === 'directory') {
      setExpanded((current) => toggled(current, node.path))
      setSelectedPath(node.path)
      return
    }
    setSelectedPath(node.path)
    setNotice(null)
  }

  const save = async () => {
    if (!cwd || !selected || selected.kind !== 'file' || reading || readFailed || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await files.write(cwd, selected.path, content, provider, savedContent)
      setSavedContent(content)
      setNotice('已保存')
      await refresh(selected.path)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setSaving(false)
    }
  }

  const createEntry = async (kind: 'file' | 'directory') => {
    if (!cwd || !tree || selected?.virtual) return
    if (dirty && !window.confirm('当前文件有未保存的修改，确定继续创建吗？')) return
    const selectedBase = createBase(selected, tree)
    const base = kind === 'directory' && selectedBase?.source !== 'harness'
      ? flattenNodes(tree.roots).find((root) => root.source === 'harness' && !root.virtual) ?? null
      : selectedBase
    if (!base) return
    const suggested = kind === 'directory'
      ? 'new-folder'
      : base.source === 'harness' ? 'notes.md' : provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
    const name = window.prompt(kind === 'directory' ? '新目录名称' : '新文件名称', suggested)?.trim()
    if (!name) return
    const path = joinPath(base.path, name)
    setError(null)
    try {
      if (kind === 'directory') await files.createDirectory(cwd, path, provider)
      else await files.write(cwd, path, '', provider)
      setExpanded((current) => new Set(current).add(base.path))
      await refresh(path)
      setNotice(kind === 'directory' ? '目录已创建' : '文件已创建')
    } catch (nextError) {
      setError(messageOf(nextError))
    }
  }

  const renameSelected = async () => {
    if (!cwd || !selected || !selected.exists || isTreeRoot(selected, tree)) return
    if (dirty && !window.confirm('当前文件有未保存的修改，确定放弃修改并重命名吗？')) return
    const name = window.prompt('新名称', selected.name)?.trim()
    if (!name || name === selected.name) return
    const nextPath = joinPath(parentPath(selected.path), name)
    setError(null)
    try {
      await files.rename(cwd, selected.path, nextPath, provider)
      await refresh(nextPath)
      setNotice('已重命名')
    } catch (nextError) {
      setError(messageOf(nextError))
    }
  }

  const removeSelected = async () => {
    if (!cwd || !selected || !selected.exists || isTreeRoot(selected, tree)) return
    if (dirty && !window.confirm('当前文件有未保存的修改，确定放弃修改并删除吗？')) return
    if (!window.confirm(`确定删除“${selected.name}”吗？${selected.kind === 'directory' ? '目录中的内容也会被删除。' : ''}`)) return
    setError(null)
    try {
      await files.remove(cwd, selected.path, provider)
      await refresh(null)
      setNotice('已删除')
    } catch (nextError) {
      setError(messageOf(nextError))
    }
  }

  const onEditorKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (dirty) void save()
    }
  }

  if (!cwd) {
    return <div className="harness-files-empty"><FolderOpen size={28} /><strong>选择一个会话</strong><p>{providerLabel} 文件跟随当前线程的工作目录。</p></div>
  }

  return (
    <section className="harness-files-shell">
      <aside className="harness-files-explorer">
        <header className="harness-files-heading">
          <strong title={workspaceName}>{workspaceName}</strong>
          <button type="button" onClick={() => { if (!dirty || window.confirm('当前文件有未保存的修改，确定重新读取吗？')) void refresh(selectedPath) }} disabled={loading} title="刷新文件树"><RefreshCw className={loading ? 'spin' : ''} size={15} /></button>
        </header>
        <div className="harness-files-tools">
          <button type="button" onClick={() => void createEntry('file')} disabled={selected?.virtual || selected?.source === 'memory'} title="新建文件"><FilePlus2 size={15} />文件</button>
          <button type="button" onClick={() => void createEntry('directory')} disabled={selected?.virtual || selected?.source === 'memory'} title={`在 ${provider === 'claude' ? '.claude' : '.harness'} 内新建目录`}><FolderPlus size={15} />目录</button>
        </div>
        <nav className="harness-file-tree" aria-label={`${providerLabel} 文件`}>
          {tree?.roots.map((node) => (
            <TreeNode key={`${node.source}:${node.path}:${node.name}`} node={node} selectedPath={selectedPath} expanded={expanded} depth={0} providerLabel={providerLabel} onSelect={selectNode} />
          ))}
          {!loading && tree && tree.roots.length === 0 && <p className="harness-tree-empty">没有可管理的文件</p>}
        </nav>
      </aside>

      <main className="harness-file-editor">
        {selected?.kind === 'file' ? (
          <>
            <header className="harness-editor-heading">
              <div className="harness-editor-title">
                <FileCode2 size={17} />
                <div><strong>{selected.name}{dirty && <i>●</i>}</strong><span title={selected.path}>{selected.path}</span></div>
              </div>
              <div className="harness-editor-actions">
                {notice && <span role="status">{notice}</span>}
                <button
                  type="button"
                  onClick={() => setPreview((value) => !value)}
                  disabled={reading || readFailed}
                  title={preview ? '切换为普通文本' : '切换为 Markdown 预览'}
                  aria-label={preview ? '切换为普通文本' : '切换为 Markdown 预览'}
                  aria-pressed={preview}
                >{preview ? <Code2 size={15} /> : <Eye size={15} />}</button>
                <button type="button" onClick={() => void renameSelected()} disabled={!selected.exists || selected.source === 'memory'} title="重命名"><Pencil size={15} /></button>
                <button type="button" onClick={() => void removeSelected()} disabled={!selected.exists || selected.source === 'memory'} title="删除"><Trash2 size={15} /></button>
                <button type="button" className="primary" title={selected.source === 'memory' && selected.name === 'MEMORY.md' ? '保存正文并更新索引' : '保存'} onClick={() => void save()} disabled={saving || reading || readFailed || !dirty}><Save size={15} />{saving ? '保存中' : '保存'}</button>
              </div>
            </header>
            {preview ? (
              <div className="harness-markdown-preview markdown-body" role="region" aria-label={`${selected.name} Markdown 预览`} tabIndex={0} onKeyDown={onEditorKeyDown}>
                {!reading && !readFailed && <Markdown text={content} cwd={parentPath(selected.path)} />}
              </div>
            ) : <textarea
              className="harness-code-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={onEditorKeyDown}
              disabled={reading || readFailed || saving || (selected.source === 'memory' && !['MEMORY.md', 'memory_summary.md'].includes(selected.name))}
              spellCheck={false}
              aria-label={`${selected.name} 内容`}
            />}
          </>
        ) : (
          <div className="harness-editor-empty"><FolderOpen size={32} /><strong>{selected?.name ?? '选择文件'}</strong><p>{selected ? '从左侧选择文件进行查看和编辑。' : `正在读取当前线程的 ${providerLabel} 文件。`}</p></div>
        )}
        {error && <div className="harness-files-error">{error}</div>}
      </main>
    </section>
  )
}

function TreeNode({ node, selectedPath, expanded, depth, providerLabel, onSelect }: {
  node: HarnessFileNode
  selectedPath: string | null
  expanded: Set<string>
  depth: number
  providerLabel: string
  onSelect(node: HarnessFileNode): void
}) {
  const open = expanded.has(node.path)
  const DirectoryIcon = open ? FolderOpen : Folder
  return (
    <div className="harness-tree-branch">
      <button
        type="button"
        className={`${selectedPath === node.path ? 'selected' : ''}${node.exists ? '' : ' missing'}`}
        style={{ '--tree-depth': depth } as CSSProperties}
        onClick={() => onSelect(node)}
        title={node.virtual ? node.name : node.path}
      >
        {node.kind === 'directory' ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="tree-spacer" />}
        {node.kind === 'directory' ? <DirectoryIcon size={15} /> : <FileCode2 size={14} />}
        <span>{node.name}</span>
        {node.instructionStatus
          ? <small className={`harness-instruction-status ${node.instructionStatus}`} title={instructionStatusDescription(node.instructionStatus, providerLabel)}>{instructionStatusLabel(node.instructionStatus)}</small>
          : !node.exists && <small>未创建</small>}
      </button>
      {node.kind === 'directory' && open && node.children.map((child) => (
        <TreeNode key={`${child.source}:${child.path}:${child.name}`} node={child} selectedPath={selectedPath} expanded={expanded} depth={depth + 1} providerLabel={providerLabel} onSelect={onSelect} />
      ))}
    </div>
  )
}

export function organizeTree(tree: HarnessFileTree): HarnessFileTree {
  const global = tree.roots.find((node) => node.source === 'global')
  const project = tree.roots.find((node) => node.source === 'project')
  const harness = tree.roots.find((node) => node.source === 'harness')
  const directories = project?.children.map((node) => ({ ...node, children: [...node.children] })) ?? []
  if (harness) {
    directories.find((node) => node.path === parentPath(harness.path))?.children.push(harness)
  }
  for (let index = directories.length - 1; index > 0; index--) {
    const child = directories[index]
    child.name = child.path.split('/').filter(Boolean).pop() ?? child.path
    directories[index - 1].children.push(child)
  }
  const root = directories[0]
  if (root) root.name = root.path
  const documents: HarnessFileNode = {
    path: 'harness:documents', name: 'harness', kind: 'directory', source: 'harness',
    exists: true, virtual: true, instructionStatus: null,
    children: [
      ...(global ? [{ ...global, name: global.path }] : []),
      ...(root ? [root] : []),
    ],
  }
  return { ...tree, roots: [
    documents,
    ...tree.roots.filter((node) => !['global', 'project', 'harness'].includes(node.source)),
  ] }
}

export function flattenNodes(nodes: HarnessFileNode[]): HarnessFileNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)])
}

function toggled(current: Set<string>, path: string): Set<string> {
  const next = new Set(current)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

function createBase(selected: HarnessFileNode | null, tree: HarnessFileTree): HarnessFileNode | null {
  if (!selected) return flattenNodes(tree.roots).find((root) => root.source === 'harness' && !root.virtual) ?? null
  if (selected.kind === 'directory') return selected
  return flattenNodes(tree.roots).find((node) => node.kind === 'directory' && node.path === parentPath(selected.path)) ?? null
}

function isTreeRoot(node: HarnessFileNode, tree: HarnessFileTree | null): boolean {
  return tree?.roots.some((root) => root === node) ?? false
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : '/'
}

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/$/, '')}/${name}`
}

function instructionStatusLabel(status: NonNullable<HarnessFileNode['instructionStatus']>): string {
  if (status === 'active') return '生效'
  if (status === 'overridden') return '被覆盖'
  if (status === 'empty') return '空文件'
  if (status === 'truncated') return '部分生效'
  return '超出限制'
}

function instructionStatusDescription(status: NonNullable<HarnessFileNode['instructionStatus']>, providerLabel = 'Codex'): string {
  if (status === 'active') return `${providerLabel} 会将这个文件加入当前线程的指令链。`
  if (status === 'overridden') return '同一目录中有优先级更高的非空指令文件。'
  if (status === 'empty') return `${providerLabel} 会跳过空指令文件，并继续检查下一候选文件。`
  if (status === 'truncated') return '文件超过剩余的项目指令字节额度，只有前半部分会生效。'
  return '在读取到这个文件前已经达到项目指令字节上限。'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
