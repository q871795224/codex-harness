// Production UI, fixture-only state. Never calls a model or native storage.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterSettings } from '../../src/features/settings/RouterSettings'
import { RouterFeedbackCard } from '../../src/features/conversation/RouterFeedbackCard'
import { runtime } from '../../src/core/runtime/bridge'
import { DEFAULT_ROUTER_SETTINGS } from '../../src/core/workspace-router/settings'
import type { RouteRecord } from '../../src/core/workspace-router/service'
import '../../src/styles.css'
const params = new URLSearchParams(location.search)
const workspaces = [
  { root: '/workspace/dns-api', checkoutRoot: '/workspace/dns-api', name: 'dns-api', branch: 'main', sha: null, createdAt: 1, lastOpenedAt: 1 },
  { root: '/workspace/dns-agent', checkoutRoot: '/workspace/dns-agent', name: 'dns-agent', branch: 'main', sha: null, createdAt: 1, lastOpenedAt: 1 },
]
runtime.getAppState = async () => JSON.stringify(DEFAULT_ROUTER_SETTINGS)
runtime.setAppState = async () => {}
runtime.routerSummaries = async () => workspaces.map(w => ({ root: w.root, checkoutRoot: w.checkoutRoot, description: w.name === 'dns-api' ? 'DNS资源管理API、配置变更和服务端接口；节点解析运行时由dns-agent处理。' : 'DNS数据平面节点程序、解析行为与节点运行状态；管理接口由dns-api处理。', checkedAt: Date.now(), generatedAt: Date.now(), error: w.name === 'dns-agent' }))
const record: RouteRecord = { id: 'route', threadId: 'thread', sourceMessageId: 'message', sourceTurnId: 'turn', createdAt: 1, completedAt: 2, durationMs: 1, model: 'gpt-6.1-terra', effort: 'medium', promptVersion: 2, candidates: workspaces.map(w => ({ ...w, description: '' })), choice: { primary: workspaces[1].root, related: [] }, status: 'started', feedback: 'pending', actualWorkspace: null, history: [] }
function Preview() {
  const [route, setRoute] = useState(record)
  return <div className="app-shell" data-theme={params.get('theme') ?? 'dark'} data-flavor="stable">
    <main className="main-pane" style={{ padding: 24, overflow: 'auto' }}>
      <RouterFeedbackCard record={route} canCorrect={!params.has('running')} onFeedback={async (accurate, actual) => setRoute({ ...route, feedback: accurate ? 'accurate' : 'inaccurate', actualWorkspace: actual ?? null })} onCorrect={async actual => setRoute({ ...route, feedback: 'inaccurate', actualWorkspace: actual })} />
      <div className="settings-panel" style={{ maxWidth: 920, margin: '24px auto', width: '100%' }}><RouterSettings models={[]} workspaces={workspaces} /></div>
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
