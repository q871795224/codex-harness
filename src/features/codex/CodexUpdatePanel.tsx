import { ArrowRight, Check, Download, ExternalLink, LoaderCircle, RotateCw } from 'lucide-react'
import type { CodexUpdateStage, CodexUpdateStatus } from '../../core/codex-update/types'
import { runtime } from '../../core/runtime/bridge'

interface CodexUpdatePanelProps {
  status: CodexUpdateStatus
  updating: boolean
  updateStage: CodexUpdateStage | null
  error: string | null
  onInstall(): void
  onDefer(): void
  onSkip(): void
}

const UPDATE_STAGES: { id: CodexUpdateStage; label: string }[] = [
  { id: 'cli', label: '更新 CLI' },
  { id: 'daemon', label: '重启 App Server' },
  { id: 'reconnect', label: '重新连接' },
]

export function CodexUpdatePanel({ status, updating, updateStage, error, onInstall, onDefer, onSkip }: CodexUpdatePanelProps) {
  const latestVersion = status.latestVersion
  return (
    <section className="codex-update-panel" aria-label="Codex 更新可用">
      <header className="codex-update-head">
        <span className="codex-update-icon"><Download size={17} /></span>
        <div>
          <span>CODEX UPDATE</span>
          <h2>Codex 有新版本可用</h2>
        </div>
      </header>

      <div className="codex-update-versions" aria-label="版本变化">
        <Version label="当前 CLI / App Server" value={currentVersion(status)} />
        <ArrowRight size={15} aria-hidden />
        <Version label="最新稳定版" value={status.latestVersion} latest />
      </div>

      <p className="codex-update-copy">
        Codex CLI 与 App Server 会一起更新。安装完成后 Harness 将重启共享 daemon 并自动重新连接；其他正在连接该 daemon 的 Codex 客户端会短暂断开。
      </p>

      {latestVersion && (
        <button className="codex-update-release" type="button" onClick={() => void runtime.openExternalUrl(releaseUrl(latestVersion))}>
          查看 v{latestVersion} 更新内容<ExternalLink size={12} />
        </button>
      )}

      {updating && updateStage && (
        <div className="codex-update-progress" role="status" aria-label="Codex 更新进度">
          {UPDATE_STAGES.map((stage, index) => {
            const current = Math.max(0, UPDATE_STAGES.findIndex(({ id }) => id === updateStage))
            const state = index < current ? 'complete' : index === current ? 'active' : 'pending'
            return (
              <div className="codex-update-stage" data-state={state} key={stage.id}>
                <span className="codex-update-stage-icon">
                  {state === 'complete' ? <Check size={12} /> : state === 'active' ? <LoaderCircle className="spin" size={12} /> : index + 1}
                </span>
                <span>{stage.label}</span>
              </div>
            )
          })}
        </div>
      )}
      {error && (
        <div className="codex-update-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void runtime.openDiagnosticsDirectory()}><ExternalLink size={12} />打开日志</button>
        </div>
      )}

      <footer className="codex-update-actions">
        <button className="primary" type="button" disabled={updating} onClick={onInstall}>
          {updating ? <LoaderCircle className="spin" size={14} /> : <RotateCw size={14} />}
          更新
        </button>
        <button type="button" disabled={updating} onClick={onDefer} title="仅在当前新会话中隐藏，进入另一个新会话时再次提示">跳过</button>
        <button type="button" disabled={updating} onClick={onSkip} title="忽略当前版本，发布下一个版本后再次提示">跳过直到下个版本</button>
      </footer>
    </section>
  )
}

function releaseUrl(version: string): string {
  return `https://github.com/openai/codex/releases/tag/rust-v${encodeURIComponent(version)}`
}

function currentVersion(status: CodexUpdateStatus): string | null {
  if (status.currentVersion === status.appServerVersion) return status.currentVersion
  if (!status.currentVersion) return status.appServerVersion
  if (!status.appServerVersion) return status.currentVersion
  return `${status.currentVersion} / ${status.appServerVersion}`
}

function Version({ label, value, latest = false }: { label: string; value: string | null; latest?: boolean }) {
  return (
    <div className={latest ? 'latest' : ''}>
      <span>{label}</span>
      <strong>{value ? `v${value}` : '未知'}</strong>
    </div>
  )
}
