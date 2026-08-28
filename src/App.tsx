import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { Bot, ChevronLeft, ChevronRight, MessageSquareText, PanelLeftClose, RotateCw } from 'lucide-react'
import { useAgentRunService } from './core/agent-runs/react'
import { DEFAULT_FONT_SIZES } from './core/domain/codex'
import type { LocalConnectorService } from './core/local-connectors/types'
import type { CodexRadarService } from './core/codex-radar/types'
import type { ConversationService } from './core/conversations/types'
import type { SystemNotificationService } from './core/notifications/types'
import { PluginComposerAction, PluginHostProvider, PluginNewThreadPanel, PluginTabBoundary, usePluginHost } from './core/plugins/react'
import { QuickActionPanel } from './core/plugins/QuickActionPanel'
import { runtime } from './core/runtime/bridge'
import { Sidebar } from './features/navigation/Sidebar'
import { Composer, type ComposerDraft } from './features/conversation/Composer'
import { ConversationStats } from './features/conversation/ConversationStats'
import { ConversationHeader, ConversationView } from './features/conversation/ConversationView'
import { QueueDock } from './features/conversation/QueueDock'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { useHarness } from './features/conversation/useHarness'
import { useCodexCore } from './features/codex/useCodexCore'
import { orderConversationTabs, parseConversationTabOrder, reorderConversationTabs } from './features/conversation/tabOrder'
import { actionForShortcut, threadIndexForAction } from './features/actions/harnessActions'
import type { HarnessActionId } from './core/domain/codex'
import { builtInPlugins, defaultPluginInstances } from './plugins'

const CONVERSATION_TAB_ORDER_KEY = 'conversationTabOrder'

export default function App() {
  const harness = useHarness()
  const agentRuns = useAgentRunService(harness.selectThread, harness.startTurnInThread)
  const services = useMemo(() => ({
    'harness.agentRuns': agentRuns,
    'harness.localConnectors': {
      health: runtime.localConnectorHealth,
      listMessages: runtime.localConnectorListMessages,
      sendMessage: runtime.localConnectorSendMessage,
    } satisfies LocalConnectorService,
    'harness.codexRadar': {
      modelTable: runtime.codexRadarModelTable,
    } satisfies CodexRadarService,
    'harness.conversations': {
      onTurnCompleted: harness.onTurnCompleted,
      openThread: harness.openThread,
    } satisfies ConversationService,
    'harness.systemNotifications': {
      requestPermission: runtime.requestSystemNotificationPermission,
      send: runtime.sendSystemNotification,
      onClick: runtime.listenSystemNotificationClicks,
    } satisfies SystemNotificationService,
  }), [agentRuns, harness.onTurnCompleted, harness.openThread])

  useEffect(() => {
    const recordUnhandledError = () => {
      void runtime.recordClientDiagnostic({
        level: 'error',
        area: 'frontend',
        event: 'unhandled.error',
        errorCode: 'unhandled_error',
      }).catch(() => undefined)
    }
    window.addEventListener('error', recordUnhandledError)
    window.addEventListener('unhandledrejection', recordUnhandledError)
    return () => {
      window.removeEventListener('error', recordUnhandledError)
      window.removeEventListener('unhandledrejection', recordUnhandledError)
    }
  }, [])

  return (
    <PluginHostProvider definitions={builtInPlugins} defaultInstances={defaultPluginInstances} services={services}>
      <HarnessShell harness={harness} />
    </PluginHostProvider>
  )
}

function HarnessShell({ harness }: { harness: ReturnType<typeof useHarness> }) {
  const plugins = usePluginHost()
  const codex = useCodexCore()
  const flavor = import.meta.env.MODE === 'dev' ? 'dev' : 'stable'
  const [tab, setTab] = useState('chat')
  const [tabOrder, setTabOrder] = useState<string[]>([])
  const tabOrderRef = useRef<string[]>([])
  const [draggedTab, setDraggedTab] = useState<string | null>(null)
  const [tabDrop, setTabDrop] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rawMode, setRawMode] = useState(false)
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraft>>({})
  const [visibleThreadIds, setVisibleThreadIds] = useState<string[]>([])
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const [scrollToLatestRequest, setScrollToLatestRequest] = useState<{ threadId: string; sequence: number } | null>(null)
  const scrollRequestSequence = useRef(0)
  const conversationScrollPositions = useRef<Record<string, number>>({})
  const workspace = useMemo(
    () => harness.workspaces.find((item) => item.root === harness.threadRoots[harness.selectedThreadId ?? '']) ?? null,
    [harness.selectedThreadId, harness.threadRoots, harness.workspaces],
  )
  const pluginTabs = plugins.resolvedTabs({
    threadId: harness.selectedThreadId,
    workspaceRoot: workspace?.root ?? null,
  })
  const newThreadPanels = plugins.resolvedNewThreadPanels({
    threadId: harness.selectedThreadId,
    workspaceRoot: workspace?.root ?? null,
  })
  const composerActions = plugins.resolvedComposerActions({
    threadId: harness.selectedThreadId,
    workspaceRoot: workspace?.root ?? null,
  })
  const quickActions = plugins.resolvedQuickActions({
    threadId: harness.selectedThreadId,
    workspaceRoot: workspace?.root ?? null,
  })
  const selectedPluginTab = pluginTabs.find((entry) => pluginTabKey(entry.pluginId, entry.contribution.id) === tab) ?? null
  const orderedTabIds = orderConversationTabs(
    ['chat', ...pluginTabs.map((entry) => pluginTabKey(entry.pluginId, entry.contribution.id))],
    tabOrder,
  )

  useEffect(() => {
    void runtime.getAppState(CONVERSATION_TAB_ORDER_KEY)
      .then((saved) => {
        const next = parseConversationTabOrder(saved)
        tabOrderRef.current = next
        setTabOrder(next)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (tab !== 'chat' && !selectedPluginTab) setTab('chat')
  }, [selectedPluginTab, tab])

  useEffect(() => {
    void runtime.setWindowTheme(harness.appearance.theme).catch(() => undefined)
  }, [harness.appearance.theme])

  const runAction = useCallback((actionId: HarnessActionId) => {
    const threadIndex = threadIndexForAction(actionId)
    if (threadIndex !== null) {
      const threadId = visibleThreadIds[threadIndex]
      if (threadId) void harness.selectThread(threadId)
      return
    }
    if (actionId === 'thread.new') void harness.createThread()
    else if (actionId === 'sidebar.toggle') harness.setSidebarCollapsed(!harness.navigation.sidebarCollapsed)
    else if (actionId === 'composer.focus') setComposerFocusRequest((current) => current + 1)
  }, [harness.createThread, harness.navigation.sidebarCollapsed, harness.selectThread, harness.setSidebarCollapsed, visibleThreadIds])

  useEffect(() => {
    if (settingsOpen) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      const actionId = actionForShortcut(event, harness.keyboard.actionShortcuts)
      if (!actionId) return
      event.preventDefault()
      runAction(actionId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [harness.keyboard.actionShortcuts, runAction, settingsOpen])

  const previewConversationTabDrop = (event: DragEvent<HTMLButtonElement>, targetId: string) => {
    event.preventDefault()
    const draggedId = event.dataTransfer.getData('text/plain') || draggedTab
    if (!draggedId || draggedId === targetId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const edge = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
    if (tabDrop?.id === targetId && tabDrop.edge === edge) return
    const next = reorderConversationTabs(orderedTabIds, tabOrder, draggedId, targetId, edge)
    tabOrderRef.current = next
    setTabOrder(next)
    setTabDrop({ id: targetId, edge })
  }

  const finishConversationTabDrag = () => {
    if (draggedTab) {
      void runtime.setAppState(CONVERSATION_TAB_ORDER_KEY, JSON.stringify(tabOrderRef.current)).catch(() => undefined)
    }
    setDraggedTab(null)
    setTabDrop(null)
  }

  if (harness.phase === 'loading') return <LaunchScreen label="正在连接本机 Codex App Server…" />
  if (harness.phase === 'error') {
    return (
      <div className="boot-error">
        <div className="boot-error-mark"><Bot size={26} /></div>
        <h1>无法启动 Codex Harness</h1>
        <p>{harness.bootError}</p>
        <button type="button" onClick={() => window.location.reload()}><RotateCw size={15} />重新连接</button>
      </div>
    )
  }

  const currentQueue = harness.selectedThreadId ? harness.queues[harness.selectedThreadId] ?? [] : []
  const currentSteers = harness.selectedThreadId ? harness.pendingSteers[harness.selectedThreadId] ?? [] : []
  const currentApprovals = harness.selectedThreadId ? harness.approvals[harness.selectedThreadId] ?? [] : []
  const canMutate = !harness.currentForeignActive

  return (
    <div
      className="app-shell"
      data-flavor={flavor}
      data-theme={harness.appearance.theme}
      style={{
        '--h-navigation-font-offset': `${harness.appearance.fontSizes.navigation - DEFAULT_FONT_SIZES.navigation}px`,
        '--h-conversation-font-offset': `${harness.appearance.fontSizes.conversation - DEFAULT_FONT_SIZES.conversation}px`,
        '--h-settings-font-offset': `${harness.appearance.fontSizes.settings - DEFAULT_FONT_SIZES.settings}px`,
        '--h-plugin-font-offset': `${harness.appearance.fontSizes.plugins - DEFAULT_FONT_SIZES.plugins}px`,
        '--h-sidebar-width': `${harness.navigation.sidebarCollapsed ? 0 : harness.navigation.sidebarWidth}px`,
      } as CSSProperties}
    >
      <div className="native-titlebar-drag-region" data-tauri-drag-region />
      <Sidebar
        workspaces={harness.workspaces}
        threads={harness.threads}
        threadRoots={harness.threadRoots}
        threadStates={harness.threadStates}
        selectedThreadId={harness.selectedThreadId}
        viewMode={harness.viewMode}
        navigationLayout={harness.navigation.layout}
        threadSort={harness.navigation.sort}
        workspaceSort={harness.navigation.workspaceSort}
        manualThreadOrder={harness.navigation.manualThreadOrder}
        sidebarWidth={harness.navigation.sidebarWidth}
        sidebarCollapsed={harness.navigation.sidebarCollapsed}
        creatingThread={Boolean(harness.busy.createThread)}
        archivingOldThreads={Boolean(harness.busy.archiveOldThreads)}
        onSelectThread={(threadId) => void harness.selectThread(threadId)}
        onSelectWorkspace={harness.setSelectedWorkspaceRoot}
        onArchiveOldThreads={() => void harness.archiveOldThreads()}
        onNewThread={() => void harness.createThread()}
        onSearch={(term) => void harness.searchThreads(term)}
        onRefresh={() => void harness.refresh()}
        onViewMode={(mode) => void harness.setViewMode(mode)}
        onNavigationLayout={harness.setNavigationLayout}
        onThreadSort={harness.setThreadSort}
        onWorkspaceSort={harness.setWorkspaceSort}
        onManualThreadOrder={harness.setManualThreadOrder}
        onSidebarWidth={harness.setSidebarWidth}
        onOpenSettings={() => setSettingsOpen(true)}
        onVisibleThreadOrder={setVisibleThreadIds}
      />
      <SidebarEdgeToggle
        collapsed={harness.navigation.sidebarCollapsed}
        sidebarWidth={harness.navigation.sidebarWidth}
        onToggle={() => harness.setSidebarCollapsed(!harness.navigation.sidebarCollapsed)}
      />
      <main className="main-pane">
        {harness.currentThread ? (
          <Fragment key={harness.currentThread.id}>
            <ConversationHeader
              thread={harness.currentThread}
              workspace={workspace}
              archived={harness.viewMode === 'archived'}
              workspaceChanging={Boolean(harness.busy.threadWorkspace)}
              canChangeWorkspace={canMutate && !harness.isCurrentWorking && harness.viewMode !== 'archived'}
              onRename={(name) => void harness.renameThread(harness.currentThread!.id, name)}
              onArchive={() => void harness.archiveThread(harness.currentThread!.id)}
              onUnarchive={() => void harness.unarchiveThread(harness.currentThread!.id)}
              onChooseWorkspace={() => {
                const threadId = harness.currentThread!.id
                void harness.chooseWorkspace().then((selected) => selected
                  ? harness.changeThreadWorkspace(threadId, selected.checkoutRoot)
                  : undefined)
              }}
            />
            <div className="tab-bar">
              <div className="thread-tabs">
                {orderedTabIds.map((tabId) => {
                  const entry = tabId === 'chat'
                    ? null
                    : pluginTabs.find((candidate) => pluginTabKey(candidate.pluginId, candidate.contribution.id) === tabId)
                  if (tabId !== 'chat' && !entry) return null
                  const label = entry?.contribution.label ?? '对话'
                  const Icon = entry?.contribution.icon ?? MessageSquareText
                  return (
                    <button
                      key={tabId}
                      type="button"
                      draggable
                      className={`${tab === tabId ? 'active' : ''}${draggedTab === tabId ? ' dragging' : ''}${tabDrop?.id === tabId && draggedTab !== tabId ? ` drop-${tabDrop.edge}` : ''}`}
                      onClick={() => setTab(tabId)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', tabId)
                        tabOrderRef.current = tabOrder
                        setDraggedTab(tabId)
                      }}
                      onDragOver={(event) => {
                        event.dataTransfer.dropEffect = 'move'
                        previewConversationTabDrop(event, tabId)
                      }}
                      onDrop={(event) => event.preventDefault()}
                      onDragEnd={finishConversationTabDrag}
                      title={`拖动调整“${label}”的位置`}
                    >
                      <Icon size={15} />{label}
                    </button>
                  )
                })}
              </div>
              <span className="connection-state"><span />本机 App Server</span>
            </div>

            {tab === 'chat' ? (
              <ConversationView
                items={harness.currentDetail?.items ?? []}
                approvals={currentApprovals}
                workspace={workspace}
                workspaces={harness.workspaces}
                workspaceChanging={Boolean(harness.busy.threadWorkspace)}
                initialScrollTop={conversationScrollPositions.current[harness.currentThread.id] ?? null}
                scrollToLatestRequest={scrollToLatestRequest?.threadId === harness.currentThread.id ? scrollToLatestRequest.sequence : 0}
                hasOlderTurns={Boolean(harness.currentDetail?.nextTurnsCursor)}
                loadingOlderTurns={Boolean(harness.busy.olderTurns)}
                onAnswerApproval={(request, decision) => void harness.answerApproval(request, decision)}
                onLoadOlderTurns={() => void harness.loadOlderTurns()}
                onScrollPosition={(scrollTop) => { conversationScrollPositions.current[harness.currentThread!.id] = scrollTop }}
                onWorkspaceChange={(workspaceRoot) => harness.selectedThreadId
                  ? void harness.changeThreadWorkspace(harness.selectedThreadId, workspaceRoot)
                  : undefined}
                onChooseWorkspace={() => {
                  const threadId = harness.selectedThreadId
                  void harness.chooseWorkspace().then((selected) => selected && threadId
                    ? harness.changeThreadWorkspace(threadId, selected.checkoutRoot)
                    : undefined)
                }}
                newThreadPanels={newThreadPanels.map((panel) => (
                  <PluginNewThreadPanel
                    key={`${panel.pluginId}:${panel.contribution.id}`}
                    panel={panel}
                    props={{
                      threadId: harness.selectedThreadId,
                      workspaceRoot: workspace?.root ?? null,
                      models: codex.models,
                      settings: codex.settingsForThread(harness.selectedThreadId),
                      disabled: codex.loading || !harness.selectedThreadId || !canMutate,
                      onSettingsChange: (patch) => harness.selectedThreadId
                        ? codex.updateThreadSettings(harness.selectedThreadId, patch)
                        : undefined,
                    }}
                  />
                ))}
                rawMode={rawMode}
                onRawModeToggle={() => setRawMode((current) => !current)}
              />
            ) : selectedPluginTab ? (
              <PluginTabBoundary
                tab={selectedPluginTab}
                props={{
                  threadId: harness.selectedThreadId,
                  workspaceRoot: workspace?.root ?? null,
                  items: harness.currentDetail?.items ?? [],
                }}
              />
            ) : null}

            {harness.viewMode === 'active' && (
              <div className="input-column">
                <QueueDock
                  queue={currentQueue}
                  pendingSteers={currentSteers}
                  working={harness.isCurrentWorking}
                  canMutate={canMutate}
                  busy={harness.busy}
                  onEdit={(id, text) => void harness.editQueue(id, text)}
                  onRemove={(id) => void harness.removeQueue(id)}
                  onPromote={(queue) => void harness.promoteQueue(queue)}
                  onStart={() => void harness.startQueue()}
                />
                <Composer
                  key={harness.currentThread.id}
                  initialDraft={composerDrafts[harness.currentThread.id]}
                  disabled={harness.currentForeignActive || Boolean(harness.busy.composer)}
                  working={harness.isCurrentWorking}
                  foreignActive={harness.currentForeignActive}
                  busy={Boolean(harness.busy.composer || harness.busy.stop)}
                  contextUsage={harness.currentTokenUsage}
                  workspaceRoot={harness.currentThread?.cwd ?? workspace?.root ?? null}
                  sendShortcut={harness.keyboard.sendShortcut}
                  focusRequest={composerFocusRequest}
                  models={codex.models}
                  settings={codex.settingsForThread(harness.selectedThreadId)}
                  rawMode={rawMode}
                  followUpMode={harness.keyboard.followUpMode}
                  settingsDisabled={codex.loading}
                  onSettingsChange={(patch) => harness.selectedThreadId ? codex.updateThreadSettings(harness.selectedThreadId, patch) : undefined}
                  onFollowUpModeChange={harness.setFollowUpMode}
                  onSend={(input, mode) => {
                    const threadId = harness.currentThread!.id
                    scrollRequestSequence.current += 1
                    setScrollToLatestRequest({ threadId, sequence: scrollRequestSequence.current })
                    return harness.sendMessage(input, mode)
                  }}
                  onCommand={(command) => {
                    if (command.name === 'raw') setRawMode((current) => !current)
                    else if (command.name === 'new') runAction('thread.new')
                    else if (command.name === 'model' && harness.selectedThreadId) void codex.updateThreadSettings(harness.selectedThreadId, { model: command.model })
                    else if (command.name === 'reasoning' && harness.selectedThreadId) void codex.updateThreadSettings(harness.selectedThreadId, { effort: command.effort })
                    else if (command.name === 'permissions' && harness.selectedThreadId) void codex.updateThreadSettings(harness.selectedThreadId, { approvalPolicy: command.approvalPolicy })
                  }}
                  onStop={harness.stopTurn}
                  actions={(api) => composerActions.map((action) => (
                    <PluginComposerAction
                      key={`${action.pluginId}:${action.contribution.id}`}
                      action={action}
                      props={{
                        threadId: harness.selectedThreadId,
                        workspaceRoot: workspace?.root ?? null,
                        ...api,
                      }}
                    />
                  ))}
                  onDraftChange={(draft, hasContent) => {
                    const threadId = harness.currentThread!.id
                    setComposerDrafts((current) => ({ ...current, [threadId]: draft }))
                    harness.setThreadDraftContent(threadId, hasContent)
                  }}
                />
                <ConversationStats
                  turns={harness.currentDetail?.turns ?? []}
                  items={harness.currentDetail?.items ?? []}
                  tokenUsage={harness.currentTokenUsage}
                />
              </div>
            )}
          </Fragment>
        ) : <EmptyState hasWorkspaces={harness.workspaces.length > 0} onNewThread={() => void harness.createThread()} onWorkspace={() => void harness.chooseWorkspace()} />}
      </main>
      {harness.currentThread && harness.viewMode === 'active' && (
        <QuickActionPanel
          actions={quickActions}
          context={{
            threadId: harness.selectedThreadId,
            workspaceRoot: workspace?.root ?? null,
            checkoutRoot: harness.currentThread.cwd,
            disabled: harness.currentForeignActive,
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          theme={harness.appearance.theme}
          fontSizes={harness.appearance.fontSizes}
          sendShortcut={harness.keyboard.sendShortcut}
          followUpMode={harness.keyboard.followUpMode}
          actionShortcuts={harness.keyboard.actionShortcuts}
          workspaces={harness.workspaces}
          threads={harness.threads}
          selectedThreadId={harness.selectedThreadId}
          selectedWorkspaceRoot={(harness.selectedThreadId ? harness.threadRoots[harness.selectedThreadId] : null) ?? harness.selectedWorkspaceRoot}
          codex={codex}
          threadTitleGeneration={harness.threadTitleGeneration}
          onTheme={harness.setTheme}
          onFontSize={harness.setFontSize}
          onResetFontSizes={harness.resetFontSizes}
          onSendShortcut={harness.setSendShortcut}
          onFollowUpMode={harness.setFollowUpMode}
          onActionShortcut={harness.setActionShortcut}
          onResetActionShortcuts={harness.resetActionShortcuts}
          onThreadTitleGeneration={harness.setThreadTitleGeneration}
          onClose={() => {
            setSettingsOpen(false)
            setComposerFocusRequest((current) => current + 1)
          }}
        />
      )}
      {harness.toast && <div className={`toast ${harness.toast.kind}`}>{harness.toast.message}</div>}
    </div>
  )
}

function SidebarEdgeToggle({
  collapsed,
  sidebarWidth,
  onToggle,
}: {
  collapsed: boolean
  sidebarWidth: number
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="app-sidebar-toggle"
      style={{ left: collapsed ? 18 : sidebarWidth }}
      title={collapsed ? '展开侧边栏' : '收起侧边栏'}
      aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
      onClick={onToggle}
    >
      {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
    </button>
  )
}

function pluginTabKey(pluginId: string, contributionId: string): string {
  return `${pluginId}:${contributionId}`
}

function LaunchScreen({ label }: { label: string }) {
  return <div className="launch-screen"><span className="launch-orbit" /><span>{label}</span></div>
}

function EmptyState({ hasWorkspaces, onNewThread, onWorkspace }: { hasWorkspaces: boolean; onNewThread: () => void; onWorkspace: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon"><PanelLeftClose size={22} /></div>
      <h1>{hasWorkspaces ? '选择一个会话' : '添加第一个工作区'}</h1>
      <p>{hasWorkspaces ? '从左侧打开历史会话，或在选定的主工作区中开始新的会话。' : '导航仅显示 Git 主工作区；链接 worktree 不会成为可选工作区。'}</p>
      <button type="button" onClick={hasWorkspaces ? onNewThread : onWorkspace}>{hasWorkspaces ? '新建会话' : '添加 Git 工作区'}</button>
    </div>
  )
}
