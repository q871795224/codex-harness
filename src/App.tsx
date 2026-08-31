import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Bot, ChevronLeft, ChevronRight, ChevronUp, MessageSquareText, PanelLeftClose, RotateCw } from 'lucide-react'
import { useAgentRunService } from './core/agent-runs/react'
import type { AgentRunService } from './core/agent-runs/types'
import { DEFAULT_FONT_SIZES, type CodexConfig, type HarnessActionId, type ThreadCreditUsage } from './core/domain/codex'
import type { LocalConnectorService } from './core/local-connectors/types'
import type { CodexRadarService } from './core/codex-radar/types'
import type { ConversationService } from './core/conversations/types'
import type { SystemNotificationService } from './core/notifications/types'
import type { QuickCommandService } from './core/quick-commands/types'
import type { HarnessFilesService, HarnessInstructionConfig } from './core/harness-files/types'
import { PluginComposerAction, PluginHostProvider, PluginNewThreadPanel, PluginTabBoundary, usePluginHost } from './core/plugins/react'
import { QuickActionPanel } from './core/plugins/QuickActionPanel'
import { QuickCommandPanel } from './core/plugins/QuickCommandPanel'
import { resolveQuickPanelAnchor } from './core/plugins/quickPanelLayout'
import { runtime } from './core/runtime/bridge'
import { Sidebar } from './features/navigation/Sidebar'
import { Composer, type ComposerDraft } from './features/conversation/Composer'
import { ConversationStats } from './features/conversation/ConversationStats'
import { ConversationHeader, ConversationView } from './features/conversation/ConversationView'
import { QueueDock } from './features/conversation/QueueDock'
import { PluginSettingsDialog, SettingsDialog } from './features/settings/SettingsDialog'
import { useHarness } from './features/conversation/useHarness'
import { useCodexCore } from './features/codex/useCodexCore'
import { orderConversationTabs, parseConversationTabOrder, reorderConversationTabs } from './features/conversation/tabOrder'
import { actionForShortcut, threadIndexForAction } from './features/actions/harnessActions'
import { builtInPlugins, defaultPluginInstances } from './plugins'
import type { UsageService } from './core/usage/types'
import type { ApiWorkbenchService } from './core/api-workbench/types'
import type { TerminalService } from './core/terminal/types'

const CONVERSATION_TAB_ORDER_KEY = 'conversationTabOrder'

export default function App() {
  const harness = useHarness()
  const codex = useCodexCore()
  const agentRuns = useAgentRunService(harness.selectThread, harness.startTurnInThread)
  const harnessInstructionConfig = useRef(resolveHarnessInstructionConfig(codex.config))
  harnessInstructionConfig.current = resolveHarnessInstructionConfig(codex.config)
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
    'harness.usage': {
      cachedSnapshot: runtime.usageCachedSnapshot,
      refreshSnapshot: runtime.usageRefreshSnapshot,
    } satisfies UsageService,
    'harness.quickCommands': {
      run: runtime.runQuickCommand,
    } satisfies QuickCommandService,
    'harness.conversations': {
      onTurnCompleted: harness.onTurnCompleted,
      openThread: harness.openThread,
    } satisfies ConversationService,
    'harness.systemNotifications': {
      requestPermission: runtime.requestSystemNotificationPermission,
      send: runtime.sendSystemNotification,
      onClick: runtime.listenSystemNotificationClicks,
    } satisfies SystemNotificationService,
    'harness.files': {
      configurationKey: () => JSON.stringify(harnessInstructionConfig.current),
      list: (cwd) => runtime.listHarnessFiles(cwd, harnessInstructionConfig.current.fallbackFilenames, harnessInstructionConfig.current.maxBytes),
      read: (cwd, path) => runtime.readHarnessFile(cwd, path, harnessInstructionConfig.current.fallbackFilenames),
      write: (cwd, path, content) => runtime.writeHarnessFile(cwd, path, content, harnessInstructionConfig.current.fallbackFilenames),
      createDirectory: (cwd, path) => runtime.createHarnessDirectory(cwd, path, harnessInstructionConfig.current.fallbackFilenames),
      rename: (cwd, path, nextPath) => runtime.renameHarnessPath(cwd, path, nextPath, harnessInstructionConfig.current.fallbackFilenames),
      remove: (cwd, path) => runtime.removeHarnessPath(cwd, path, harnessInstructionConfig.current.fallbackFilenames),
    } satisfies HarnessFilesService,
    'harness.apiWorkbench': {
      load: runtime.apiWorkbenchLoad,
      save: runtime.apiWorkbenchSave,
      send: runtime.apiWorkbenchSend,
      chooseImportFiles: runtime.chooseApiWorkbenchImportFiles,
      readImportFile: runtime.apiWorkbenchReadImportFile,
    } satisfies ApiWorkbenchService,
    'harness.terminal': {
      create: runtime.terminalCreate,
      write: runtime.terminalWrite,
      resize: runtime.terminalResize,
      close: runtime.terminalClose,
      openIterm: runtime.terminalOpenIterm,
      onEvent: runtime.listenTerminalEvents,
    } satisfies TerminalService,
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
      <HarnessShell harness={harness} agentRuns={agentRuns} codex={codex} />
    </PluginHostProvider>
  )
}

function HarnessShell({ harness, agentRuns, codex }: {
  harness: ReturnType<typeof useHarness>
  agentRuns: AgentRunService
  codex: ReturnType<typeof useCodexCore>
}) {
  const plugins = usePluginHost()
  const flavor = import.meta.env.MODE === 'dev' ? 'dev' : 'stable'
  const [tab, setTab] = useState('chat')
  const [tabOrder, setTabOrder] = useState<string[]>([])
  const tabOrderRef = useRef<string[]>([])
  const [draggedTab, setDraggedTab] = useState<string | null>(null)
  const [tabDrop, setTabDrop] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  const tabDragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; moved: boolean; preview: string[] | null } | null>(null)
  const suppressTabClickRef = useRef(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [rawMode, setRawMode] = useState(false)
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraft>>({})
  const [collapsedComposerKeys, setCollapsedComposerKeys] = useState<Record<string, boolean>>({})
  const [visibleThreadIds, setVisibleThreadIds] = useState<string[]>([])
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const [threadCreditUsages, setThreadCreditUsages] = useState<Record<string, ThreadCreditUsage>>({})
  const [quickActionBottom, setQuickActionBottom] = useState<number | undefined>(undefined)
  const [scrollToLatestRequest, setScrollToLatestRequest] = useState<{ threadId: string; sequence: number } | null>(null)
  const scrollRequestSequence = useRef(0)
  const conversationScrollPositions = useRef<Record<string, number>>({})
  const inputColumnRef = useRef<HTMLDivElement>(null)
  const workspace = useMemo(
    () => harness.workspaces.find((item) => item.root === harness.threadRoots[harness.selectedThreadId ?? '']) ?? null,
    [harness.selectedThreadId, harness.threadRoots, harness.workspaces],
  )
  const threadCwd = harness.currentThread?.cwd ?? null
  const pluginTabs = plugins.resolvedTabs({
    threadId: harness.selectedThreadId,
    threadCwd,
    workspaceRoot: workspace?.root ?? null,
  })
  const newThreadPanels = plugins.resolvedNewThreadPanels({
    threadId: harness.selectedThreadId,
    threadCwd,
    workspaceRoot: workspace?.root ?? null,
  })
  const composerActions = plugins.resolvedComposerActions({
    threadId: harness.selectedThreadId,
    threadCwd,
    workspaceRoot: workspace?.root ?? null,
  })
  const quickActions = plugins.resolvedQuickActions({
    threadId: harness.selectedThreadId,
    threadCwd,
    workspaceRoot: workspace?.root ?? null,
  })
  const quickCommands = plugins.resolvedQuickCommands({
    threadId: harness.selectedThreadId,
    threadCwd,
    workspaceRoot: workspace?.root ?? null,
  })
  const selectedPluginTab = pluginTabs.find((entry) => pluginTabKey(entry.pluginId, entry.contribution.id) === tab) ?? null
  const composerCollapsible = Boolean(selectedPluginTab?.contribution.collapsibleComposer)
  const composerCollapseKey = `${harness.selectedThreadId ?? 'none'}:${tab}`
  const composerCollapsed = composerCollapsible && Boolean(collapsedComposerKeys[composerCollapseKey])
  const composerVisible = harness.viewMode === 'active' && !selectedPluginTab?.contribution.hideComposer && !composerCollapsed
  const quickPanelBottom = resolveQuickPanelAnchor(composerVisible, quickActionBottom)
  const orderedTabIds = orderConversationTabs(
    ['chat', ...pluginTabs.map((entry) => pluginTabKey(entry.pluginId, entry.contribution.id))],
    tabOrder,
  )
  const latestTurn = harness.currentDetail?.turns.at(-1) ?? null

  useEffect(() => {
    const threadId = harness.selectedThreadId
    if (!threadId) return undefined
    let disposed = false
    void runtime.readThreadCreditUsage(threadId)
      .then((usage) => {
        if (!disposed && usage) setThreadCreditUsages((current) => ({ ...current, [threadId]: usage }))
      })
      .catch(() => undefined)
    return () => { disposed = true }
  }, [harness.selectedThreadId, latestTurn?.completedAt, latestTurn?.id])

  useLayoutEffect(() => {
    const column = inputColumnRef.current
    const card = column?.querySelector<HTMLElement>('[data-composer-card]')
    if (!column || !card) {
      setQuickActionBottom(undefined)
      return undefined
    }
    const update = () => setQuickActionBottom(Math.max(0, Math.round(window.innerHeight - card.getBoundingClientRect().bottom)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(column)
    observer.observe(card)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [harness.selectedThreadId, harness.viewMode, tab])

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
    if (settingsOpen || pluginsOpen) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      const actionId = actionForShortcut(event, harness.keyboard.actionShortcuts)
      if (!actionId) return
      event.preventDefault()
      runAction(actionId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [harness.keyboard.actionShortcuts, pluginsOpen, runAction, settingsOpen])

  const previewConversationTabDrop = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = tabDragRef.current
    if (!drag) return
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return
    if (!drag.moved) {
      drag.moved = true
      setDraggedTab(drag.id)
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-conversation-tab-id]')
    const targetId = target?.dataset.conversationTabId
    if (!target || !targetId || drag.id === targetId) return
    const bounds = target.getBoundingClientRect()
    const edge = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
    if (tabDrop?.id === targetId && tabDrop.edge === edge) return
    const base = drag.preview ?? orderedTabIds
    const next = reorderConversationTabs(base, drag.preview ?? tabOrder, drag.id, targetId, edge)
    drag.preview = next
    setTabOrder(next)
    setTabDrop({ id: targetId, edge })
  }

  const finishConversationTabDrag = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const drag = tabDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.moved) {
      suppressTabClickRef.current = true
      window.setTimeout(() => { suppressTabClickRef.current = false }, 0)
      const next = commit && drag.preview ? drag.preview : tabOrderRef.current
      tabOrderRef.current = next
      setTabOrder(next)
      if (commit && drag.preview) void runtime.setAppState(CONVERSATION_TAB_ORDER_KEY, JSON.stringify(next)).catch(() => undefined)
    }
    tabDragRef.current = null
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
  const currentActiveTurn = harness.activeTurnId
    ? harness.currentDetail?.turns.find((turn) => turn.id === harness.activeTurnId) ?? null
    : null
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
        onOpenSettings={() => { setPluginsOpen(false); setSettingsOpen(true) }}
        onOpenPlugins={() => { setSettingsOpen(false); setPluginsOpen(true) }}
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
                      data-conversation-tab-id={tabId}
                      className={`${tab === tabId ? 'active' : ''}${draggedTab === tabId ? ' dragging' : ''}${tabDrop?.id === tabId && draggedTab !== tabId ? ` drop-${tabDrop.edge}` : ''}`}
                      onClick={(event) => {
                        if (suppressTabClickRef.current) event.preventDefault()
                        else setTab(tabId)
                      }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return
                        tabOrderRef.current = tabOrder
                        tabDragRef.current = { id: tabId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, preview: null }
                        event.currentTarget.setPointerCapture(event.pointerId)
                      }}
                      onPointerMove={previewConversationTabDrop}
                      onPointerUp={(event) => finishConversationTabDrag(event, true)}
                      onPointerCancel={(event) => finishConversationTabDrag(event, false)}
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
                      threadCwd,
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
                working={harness.isCurrentWorking}
                workingTurnId={currentActiveTurn?.id ?? null}
                workingStartedAt={currentActiveTurn?.startedAt ?? null}
                onRawModeToggle={() => setRawMode((current) => !current)}
              />
            ) : selectedPluginTab ? (
              <PluginTabBoundary
                tab={selectedPluginTab}
                props={{
                  threadId: harness.selectedThreadId,
                  threadCwd,
                  workspaceRoot: workspace?.root ?? null,
                  items: harness.currentDetail?.items ?? [],
                  workspaces: harness.workspaces,
                  threads: harness.threads,
                }}
              />
            ) : null}

            {harness.viewMode === 'active' && composerCollapsible && composerCollapsed && (
              <div className="composer-collapsed-handle">
                <button
                  className="composer-collapse-toggle collapsed"
                  type="button"
                  onClick={() => setCollapsedComposerKeys((current) => ({ ...current, [composerCollapseKey]: false }))}
                  aria-label="展开对话输入框"
                  title="展开对话输入框"
                >
                  <ChevronUp size={12} />
                </button>
              </div>
            )}

            {composerVisible && (
              <div className="input-column" ref={inputColumnRef}>
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
                  autoFocus={!composerCollapsible}
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
                    else if (command.name === 'reset') return harness.resetThread()
                    else if (command.name === 'model' && harness.selectedThreadId) void codex.updateThreadSettings(harness.selectedThreadId, { model: command.model })
                    else if (command.name === 'reasoning' && harness.selectedThreadId) void codex.updateThreadSettings(harness.selectedThreadId, { effort: command.effort })
                    else if (command.name === 'permissions' && harness.selectedThreadId) void codex.updateThreadSettings(harness.selectedThreadId, { approvalPolicy: command.approvalPolicy })
                  }}
                  onStop={harness.stopTurn}
                  onCollapse={composerCollapsible
                    ? () => setCollapsedComposerKeys((current) => ({ ...current, [composerCollapseKey]: true }))
                    : undefined}
                  actions={(api) => composerActions.map((action) => (
                    <PluginComposerAction
                      key={`${action.pluginId}:${action.contribution.id}`}
                      action={action}
                      props={{
                        threadId: harness.selectedThreadId,
                        threadCwd,
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
                  creditUsage={harness.selectedThreadId ? threadCreditUsages[harness.selectedThreadId] ?? null : null}
                  thread={harness.currentThread}
                  workspace={workspace}
                  taskPlan={harness.currentTaskPlan}
                  preferences={harness.conversationStats}
                />
              </div>
            )}
          </Fragment>
        ) : <EmptyState hasWorkspaces={harness.workspaces.length > 0} onNewThread={() => void harness.createThread()} onWorkspace={() => void harness.chooseWorkspace()} />}
      </main>
      {harness.currentThread && harness.viewMode === 'active' && (
        <>
          <QuickCommandPanel commands={quickCommands} anchorBottom={quickPanelBottom} />
          <QuickActionPanel
            actions={quickActions}
            agentRuns={agentRuns}
            anchorBottom={quickPanelBottom}
            context={{
              threadId: harness.selectedThreadId,
              threadCwd,
              workspaceRoot: workspace?.root ?? null,
              checkoutRoot: harness.currentThread.cwd,
              disabled: harness.currentForeignActive,
            }}
          />
        </>
      )}
      {settingsOpen && (
        <SettingsDialog
          theme={harness.appearance.theme}
          fontSizes={harness.appearance.fontSizes}
          sendShortcut={harness.keyboard.sendShortcut}
          followUpMode={harness.keyboard.followUpMode}
          actionShortcuts={harness.keyboard.actionShortcuts}
          selectedWorkspaceRoot={(harness.selectedThreadId ? harness.threadRoots[harness.selectedThreadId] : null) ?? harness.selectedWorkspaceRoot}
          codex={codex}
          threadTitleGeneration={harness.threadTitleGeneration}
          conversationStats={harness.conversationStats}
          conversationStatsData={{
            turns: harness.currentDetail?.turns ?? [],
            items: harness.currentDetail?.items ?? [],
            tokenUsage: harness.currentTokenUsage,
            creditUsage: harness.selectedThreadId ? threadCreditUsages[harness.selectedThreadId] ?? null : null,
            thread: harness.currentThread,
            workspace,
            taskPlan: harness.currentTaskPlan,
          }}
          onTheme={harness.setTheme}
          onFontSize={harness.setFontSize}
          onResetFontSizes={harness.resetFontSizes}
          onSendShortcut={harness.setSendShortcut}
          onFollowUpMode={harness.setFollowUpMode}
          onActionShortcut={harness.setActionShortcut}
          onResetActionShortcuts={harness.resetActionShortcuts}
          onThreadTitleGeneration={harness.setThreadTitleGeneration}
          onConversationStats={harness.setConversationStats}
          onOpenPlugins={() => { setSettingsOpen(false); setPluginsOpen(true) }}
          onClose={() => {
            setSettingsOpen(false)
            setComposerFocusRequest((current) => current + 1)
          }}
        />
      )}
      {pluginsOpen && (
        <PluginSettingsDialog
          workspaces={harness.workspaces}
          threads={harness.threads}
          selectedThreadId={harness.selectedThreadId}
          models={codex.models}
          onOpenSettings={() => { setPluginsOpen(false); setSettingsOpen(true) }}
          onClose={() => {
            setPluginsOpen(false)
            setComposerFocusRequest((current) => current + 1)
          }}
        />
      )}
      {harness.toast && <div className={`toast ${harness.toast.kind}`}>{harness.toast.message}</div>}
    </div>
  )
}

function resolveHarnessInstructionConfig(config: CodexConfig): HarnessInstructionConfig {
  const fallbackFilenames = (config.project_doc_fallback_filenames ?? [])
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  const maxBytes = Number.isSafeInteger(config.project_doc_max_bytes) && (config.project_doc_max_bytes ?? 0) > 0
    ? config.project_doc_max_bytes!
    : 32 * 1024
  return { fallbackFilenames, maxBytes }
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
