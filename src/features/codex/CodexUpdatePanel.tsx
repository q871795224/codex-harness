import { ArrowRight, Download, ExternalLink, LoaderCircle, RotateCw } from 'lucide-react'
import type { CodexUpdateStatus } from '../../core/codex-update/types'
import { runtime } from '../../core/runtime/bridge'

interface CodexUpdatePanelProps {
  status: CodexUpdateStatus
  updating: boolean
  error: string | null
  onInstall(): void
  onDefer(): void
  onSkip(): void
}

export function CodexUpdatePanel({ status, updating, error, onInstall, onDefer, onSkip }: CodexUpdatePanelProps) {
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

      {updating && (
        <div className="codex-update-progress" role="status">
          <LoaderCircle className="spin" size={14} />
          <span>正在更新 CLI → 重启 App Server → 重新连接…</span>
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
