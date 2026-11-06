// Production UI, fixture-only state. Never calls a model or native storage.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GitBranch, MessageSquareText, Clock3 } from 'lucide-react'
import { RouterSettings } from '../../src/features/settings/RouterSettings'
import { RouterFeedbackCard } from '../../src/features/conversation/RouterFeedbackCard'
import { runtime } from '../../src/core/runtime/bridge'
import { DEFAULT_ROUTER_SETTINGS } from '../../src/core/workspace-router/settings'
import type { RouterSummary } from '../../src/core/workspace-router/types'
import type { RouteRecord } from '../../src/core/workspace-router/service'
import type { CodexModel } from '../../src/core/domain/codex'
import '../../src/styles.css'
const params = new URLSearchParams(location.search)
const workspaces = [
  { root: '/workspace/dns-api', checkoutRoot: '/workspace/dns-api', name: 'dns-api', branch: 'main', sha: null, createdAt: 1, lastOpenedAt: 1 },
  { root: '/workspace/dns-agent', checkoutRoot: '/workspace/dns-agent', name: 'dns-agent', branch: 'main', sha: null, createdAt: 1, lastOpenedAt: 1 },
  { root: '/workspace/codex-harness', checkoutRoot: '/workspace/codex-harness', name: 'codex-harness', branch: 'main', sha: null, createdAt: 1, lastOpenedAt: 1 },
]
let settings = { ...DEFAULT_ROUTER_SETTINGS }
const start = Date.now(), day = 24 * 60 * 60_000
let summaries: RouterSummary[] = workspaces.map((w, i) => ({ root: w.root, checkoutRoot: w.checkoutRoot, description: i === 0 ? 'DNS 管理侧 API，负责域名、解析记录、服务配置与管理接口。适合接口开发、配置变更和服务端排障；节点解析程序与运行行为由 dns-agent 工作区处理。' : i === 1 ? 'DNS 数据平面节点程序，负责解析请求处理、节点配置同步与运行状态。适合解析行为、性能与节点故障排查；管理侧接口位于 dns-api。' : '', checkedAt: start - 3 * 60 * 60_000, generatedAt: i < 2 ? start - 6 * 60 * 60_000 : null, nextCheckAt: start + day - 3 * 60 * 60_000, error: i === 1 }))
runtime.getAppState = async () => JSON.stringify(settings)
runtime.setAppState = async (_key, value) => { settings = JSON.parse(value) }
runtime.routerSummaries = async () => summaries
runtime.claimRouterSummary = async root => {
  await new Promise(resolve => setTimeout(resolve, 500))
  summaries = summaries.map(s => s.root === root ? { ...s, checkedAt: Date.now(), nextCheckAt: Date.now() + day, error: false } : s)
  return null // Fixture documents are unchanged: exercises refresh without a model call.
}
const models: CodexModel[] = ['gpt-6.1-terra', 'gpt-6.1-sol'].map(model => ({ id: model, model, displayName: model, description: '', hidden: false, supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], isDefault: model === 'gpt-6.1-terra' }))
const record: RouteRecord = { id: 'route', threadId: 'thread', sourceMessageId: 'message', sourceTurnId: 'turn', createdAt: 1, completedAt: 2, durationMs: 1, model: 'gpt-6.1-terra', effort: 'medium', promptVersion: 2, candidates: workspaces.map(w => ({ ...w, description: '' })), choice: { primary: workspaces[1].root, related: [] }, status: 'started', feedback: 'pending', actualWorkspace: null, history: [] }
function Preview() {
  const [route, setRoute] = useState(record)
  const correction = params.get('scenario') === 'correction'
  return <div className="app-shell" data-theme={params.get('theme') ?? 'dark'} data-flavor="stable">
    <main className="main-pane">
      <header className="thread-header"><div><h3>工作区自动选择评审</h3><small>codex-harness · 示例数据</small></div></header>
      <div className="tab-bar"><div className="thread-tabs"><button type="button"><MessageSquareText size={15} />对话</button><button type="button"><Clock3 size={15} />异步任务</button><button type="button" className="active"><GitBranch size={15} />Router</button></div></div>
      {correction && <RouterFeedbackCard record={route} canCorrect={!params.has('running')} onFeedback={async (accurate, actual) => setRoute({ ...route, feedback: accurate ? 'accurate' : 'inaccurate', actualWorkspace: actual ?? null })} onCorrect={async actual => setRoute({ ...route, feedback: 'inaccurate', actualWorkspace: actual })} />}
      <RouterSettings models={models} workspaces={workspaces} initialSection={params.has('configuration') ? 'configuration' : 'workspaces'} standalone />
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
