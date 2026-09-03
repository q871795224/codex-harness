import { useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ChevronUp, CircleAlert, LoaderCircle, PackageOpen, Play, Terminal } from 'lucide-react'
import type { QuickCommandContribution } from '../../extensions/types'
import { RELEASE_PHASE_LABELS, type WorkspaceReleaseController } from '../release-command/types'
import type { ResolvedContribution } from './runtime'

interface QuickCommandPanelProps {
  commands: ResolvedContribution<QuickCommandContribution>[]
  release?: WorkspaceReleaseController
  anchorBottom?: number
}

type CommandState = { phase: 'running' | 'success' | 'failed'; message: string }

export function QuickCommandPanel({ commands, release, anchorBottom }: QuickCommandPanelProps) {
  const [open, setOpen] = useState(false)
  const [releasePicker, setReleasePicker] = useState(false)
  const [releaseRefreshing, setReleaseRefreshing] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, CommandState>>({})
  const releaseVisible = Boolean(release?.supported)
  const releaseRunning = release?.status?.status === 'running'
  if (commands.length === 0 && !releaseVisible) return null

  const run = async (entry: ResolvedContribution<QuickCommandContribution>) => {
    const key = entry.instanceId
    setStates((current) => ({ ...current, [key]: { phase: 'running', message: '后台执行中…' } }))
    try {
      const result = await entry.contribution.run()
      setStates((current) => ({
        ...current,
        [key]: { phase: result.success ? 'success' : 'failed', message: result.message },
      }))
    } catch (error) {
      setStates((current) => ({
        ...current,
        [key]: { phase: 'failed', message: error instanceof Error ? error.message : String(error) },
      }))
    }
  }

  const startRelease = async (version: string) => {
    if (!release) return
    setReleasePicker(false)
    setReleaseError(null)
    try {
      await release.start(version)
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleReleasePicker = async () => {
    if (!release) return
    if (releasePicker) {
      setReleasePicker(false)
      return
    }
    setReleaseError(null)
    setReleaseRefreshing(true)
    try {
      await release.refresh()
      setReleasePicker(true)
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : String(error))
    } finally {
      setReleaseRefreshing(false)
    }
  }

  return (
    <div className={`quick-command-dock${open ? ' open' : ''}`} style={anchorBottom === undefined ? undefined : { bottom: anchorBottom }}>
      {open ? (
        <section className="quick-command-panel" aria-label="快捷命令">
          <header>
            <button type="button" aria-label="收起快捷命令" title="收起" onClick={() => { setOpen(false); setReleasePicker(false) }}><ChevronLeft size={15} /></button>
            <span><Terminal size={15} />快捷命令</span>
          </header>
          <div className="quick-command-list">
            {releaseVisible && release && (
              <div className="quick-command-release">
                <button
                  type="button"
                  disabled={releaseRunning || releaseRefreshing}
                  onClick={() => void toggleReleasePicker()}
                  aria-expanded={releasePicker}
                  aria-label="发布 Codex Harness"
                  title="创建并合并发布 PR、安装本机版本并发布到 GitHub"
                >
                  <span className={`quick-command-icon ${release.status?.status === 'succeeded' ? 'success' : release.status?.status ?? 'idle'}`}>
                    {releaseRunning || releaseRefreshing ? <LoaderCircle className="spin" size={14} />
                      : release.status?.status === 'succeeded' ? <Check size={14} />
                        : release.status?.status === 'failed' ? <CircleAlert size={14} />
                          : <PackageOpen size={14} />}
                  </span>
                  <strong>发布</strong>
                  {release.status ? (
                    <small className={release.status.status === 'failed' ? 'failed' : release.status.status === 'succeeded' ? 'success' : ''}>
                      {release.status.version} · {RELEASE_PHASE_LABELS[release.status.phase] ?? release.status.phase}
                    </small>
                  ) : <ChevronRight className="quick-command-release-chevron" size={13} />}
                </button>
                {releasePicker && (
                  <div className="release-version-menu" role="menu" aria-label="选择发布版本">
                    <span>发布至</span>
                    <div>
                      {release.versions.map((version) => (
                        <button key={version} type="button" role="menuitem" onClick={() => void startRelease(version)}>{version}</button>
                      ))}
                    </div>
                    <small>合并 PR · 安装本机 · GitHub Release</small>
                  </div>
                )}
                {releaseError && <p className="quick-command-release-error" role="alert">{releaseError}</p>}
              </div>
            )}
            {commands.map((entry) => {
              const state = states[entry.instanceId]
              const running = state?.phase === 'running'
              return (
                <button
                  key={`${entry.pluginId}:${entry.instanceId}:${entry.contribution.id}`}
                  type="button"
                  disabled={running}
                  onClick={() => void run(entry)}
                  title={`${entry.contribution.command}${state ? `\n${state.message}` : ''}`}
                  aria-label={`${entry.contribution.label}：${entry.contribution.command}`}
                >
                  <span className={`quick-command-icon ${state?.phase ?? 'idle'}`}>
                    {running ? <LoaderCircle className="spin" size={14} />
                      : state?.phase === 'success' ? <Check size={14} />
                        : state?.phase === 'failed' ? <CircleAlert size={14} />
                          : <Play size={13} fill="currentColor" />}
                  </span>
                  <strong>{entry.contribution.label}</strong>
                  {state && <small className={state.phase}>{state.message}</small>}
                </button>
              )
            })}
          </div>
        </section>
      ) : (
        <button type="button" className="quick-command-trigger" aria-label="打开快捷命令" title="快捷命令" onClick={() => setOpen(true)}>
          <ChevronUp size={13} />{releaseRunning ? <LoaderCircle className="spin" size={17} /> : <Terminal size={17} />}
        </button>
      )}
    </div>
  )
}
