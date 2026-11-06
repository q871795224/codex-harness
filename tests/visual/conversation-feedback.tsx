// Real production components with in-memory data; no native APIs or model calls.
import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Bell } from 'lucide-react'
import { ConversationHeader, ConversationView } from '../../src/features/conversation/ConversationView'
import { Composer, type ComposerDraft } from '../../src/features/conversation/Composer'
import { RouterFeedbackCard } from '../../src/features/conversation/RouterFeedbackCard'
import { UserInputRequestCard } from '../../src/features/conversation/UserInputRequestCard'
import { NotificationViewport } from '../../src/features/notifications/Notifications'
import { attentionGroups, createNotificationStore } from '../../src/core/notifications/store'
import type { RouteRecord } from '../../src/core/workspace-router/service'
import type { Thread, Turn, ThreadItemEntry, CodexModel, Workspace, ApprovalRequest } from '../../src/core/domain/codex'
import '../../src/styles.css'

const noop = () => {}
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'route'
const sidebar = new URLSearchParams(location.search).has('sidebar')
const theme = new URLSearchParams(location.search).get('theme') ?? 'dark'
const workspace: Workspace = { root: '/workspace/codex-harness', checkoutRoot: '/workspace/codex-harness', name: 'codex-harness', branch: 'fix/conversation-feedback-reminders', sha: null, createdAt: 1, lastOpenedAt: 1 }
const thread: Thread = { id: 'demo', name: 'SeaTalk 继续会话', preview: '', cwd: workspace.root, ephemeral: false, createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: 'idle' } }
const initialRoute: RouteRecord = { id: 'route', threadId: thread.id, sourceMessageId: 'user-1', sourceTurnId: 'turn-1', createdAt: 1, completedAt: 2, durationMs: 1, model: 'gpt-6.1-terra', effort: 'medium', promptVersion: 1, candidates: [{ ...workspace, description: '' }, { root: '/workspace/seatalk-bot', checkoutRoot: '/workspace/seatalk-bot', name: 'seatalk-bot', description: '' }], choice: { primary: workspace.root, related: [] }, status: 'started', feedback: 'pending', actualWorkspace: null, history: [] }
const model: CodexModel = { id: 'sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'], isDefault: true }
const turns: Turn[] = [{ id: 'turn-1', itemsView: 'full', items: [], status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1 }]
const initialItems: ThreadItemEntry[] = [
  { turnId: 'turn-1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '我想给 Harness 加个功能，通过 SeaTalk 继续会话。这样我不在电脑前时，也能用手机继续工作。', text_elements: [] }] } },
  { turnId: 'turn-1', item: { id: 'agent-1', type: 'agentMessage', phase: 'final_answer', text: '可以，通过 SeaTalk 接收你的输入并继续指定会话。我会先检查现有 Bot 和会话接入能力。' } },
]
const request: ApprovalRequest = { id: 'question', threadId: thread.id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'bot', header: '问题 1', question: 'SeaTalk Bot 有现成可复用的吗？有的话给我名称；没有的话，我按“Codex Harness”作为名称准备接入。' }] } }
const store = createNotificationStore({ load: async () => null, save: async () => {} })
await store.initialize()
store.publish({ level: 'warning', source: '会话', title: 'SeaTalk 接入需要你确认', message: '选择要使用的 Bot 后即可继续。', state: 'pending', threadId: 'bot-task', workspaceRoot: workspace.root })
store.publish({ level: 'info', source: '会话', title: 'DNS 查询结果已就绪', message: '传播检查已完成，可以查看结果。', threadId: 'dns-task', workspaceRoot: '/workspace/dns' })
store.publish({ level: 'info', source: '跟进', title: '检查测试环境部署结果', message: '之前设置的跟进时间已到。', attention: 'follow-up', threadId: 'deploy-task' })
store.snapshot().records.forEach(record => store.dismiss(record.id))

function Preview() {
  const [route, setRoute] = useState(initialRoute)
  const [items, setItems] = useState(initialItems)
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [draft, setDraft] = useState<ComposerDraft>()
  const [consumed, setConsumed] = useState<ComposerDraft>()
  const [questionOpen, setQuestionOpen] = useState(scenario === 'question')
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  return <div className="app-shell" data-theme={theme} data-flavor="stable" style={{ '--h-sidebar-width': sidebar ? '284px' : '0px' } as React.CSSProperties}>
    {sidebar && <aside className="sidebar" aria-label="侧栏布局占位" />}
    <main className="main-pane"><div className="notification-conversation">
      <ConversationHeader thread={thread} workspace={workspace} gitContextResolved archived={false} isWorking={false} pinned={false} workspaceChanging={false} canChangeWorkspace={false} onRename={noop} onArchive={noop} onUnarchive={noop} onTogglePinned={noop} onChooseWorkspace={noop} />
      <div className="tab-bar"><div className="thread-tabs"><button className="active">对话</button><button>待办</button>{sidebar && ['异步任务', '提示词', '团队', '用量', '轨迹', 'Harness', '项目', 'API', '终端'].map(label => <button key={label}>{label}</button>)}</div><div className="notification-tab-tools"><button type="button" className="notification-bell" aria-label="打开通知提醒" aria-expanded={remindersOpen} aria-controls="notification-reminder-rail" onClick={() => setRemindersOpen(!remindersOpen)}><Bell size={16} /><b>{attentionGroups(state.records).length}</b></button><span className="connection-state"><span />本机 App Server</span></div></div>
      <ConversationView threadId={thread.id} items={items} turns={turns} cwd={thread.cwd} approvals={[]} workspace={workspace} workspaces={[workspace]} workspaceChanging={false} initialScrollTop={0} scrollToLatestRequest={0} hasOlderTurns={false} loadingOlderTurns={false} onAnswerApproval={noop} onLoadOlderTurns={noop} onScrollPosition={noop} onWorkspaceChange={noop} onChooseWorkspace={noop} rawMode={false} working={false} workingTurnId={null} workingStartedAt={null} onRawModeToggle={noop}
        banners={<>{scenario !== 'question' && <RouterFeedbackCard record={route} onFeedback={async (accurate, actual) => setRoute({ ...route, feedback: accurate ? 'accurate' : 'inaccurate', actualWorkspace: actual ?? null })} />}{questionOpen && <UserInputRequestCard request={request} sendShortcut="mod-enter" onAnswer={async () => setQuestionOpen(false)} />}</>} />
      <div className="input-column"><Composer disabled={false} working={false} foreignActive={false} busy={false} contextUsage={null} workspaceRoot={workspace.root} sendShortcut="mod-enter" focusRequest={0} autoFocus={false} models={[model]} settings={{ model: model.model, effort: 'high', serviceTier: null, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access' }} rawMode={false} followUpMode="interject" onSettingsChange={noop} onFollowUpModeChange={noop} onCommand={noop} onStop={noop} onDraftChange={setDraft} consumedDraft={consumed} onSend={async (input) => {
        await new Promise(resolve => setTimeout(resolve, 150))
        setItems([...items, { turnId: 'turn-2', item: { id: 'user-2', type: 'userMessage', content: input } }])
        setRoute({ ...route, feedbackDismissedAt: Date.now() })
        setConsumed(draft)
      }} /></div>
    </div></main>
    <NotificationViewport store={store} onOpen={noop} open={remindersOpen} onToggle={setRemindersOpen} onAction={async () => {}} currentThread={{ id: thread.id, title: thread.name! }} />
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
