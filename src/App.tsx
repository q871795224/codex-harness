import { useEffect, useMemo, useState } from 'react'
import { Bot, MessageSquareText, PanelLeftClose, RotateCw } from 'lucide-react'
import { PluginHostProvider, PluginTabBoundary, usePluginHost } from './core/plugins/react'
import { Sidebar } from './features/navigation/Sidebar'
import { Composer } from './features/conversation/Composer'
import { ConversationStats } from './features/conversation/ConversationStats'
import { ConversationHeader, ConversationView } from './features/conversation/ConversationView'
import { QueueDock } from './features/conversation/QueueDock'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { useHarness } from './features/conversation/useHarness'
import { builtInPlugins, defaultPluginInstances } from './plugins/trajectory'

export default function App() {
  const harness = useHarness()
  return (
    <PluginHostProvider definitions={builtInPlugins} defaultInstances={defaultPluginInstances}>
      <HarnessShell harness={harness} />
    </PluginHostProvider>
  )
}

function HarnessShell({ harness }: { harness: ReturnType<typeof useHarness> }) {
  const plugins = usePluginHost()
  const flavor = import.meta.env.MODE === 'dev' ? 'dev' : 'stable'
  const [tab, setTab] = useState('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const workspace = useMemo(
    () => harness.workspaces.find((item) => item.root === harness.threadRoots[harness.selectedThreadId ?? '']) ?? null,
    [harness.selectedThreadId, harness.threadRoots, harness.workspaces],
  )
  const pluginTabs = plugins.resolvedTabs({
    threadId: harness.selectedThreadId,
    workspaceRoot: workspace?.root ?? null,
  })
  const selectedPluginTab = pluginTabs.find((entry) => pluginTabKey(entry.pluginId, entry.contribution.id) === tab) ?? null

  useEffect(() => {
    if (tab !== 'chat' && !selectedPluginTab) setTab('chat')
  }, [selectedPluginTab, tab])

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
    <div className="app-shell" data-font-size={harness.appearance.fontSize} data-flavor={flavor}>
      <Sidebar
        workspaces={harness.workspaces}
        threads={harness.threads}
        threadRoots={harness.threadRoots}
        threadStates={harness.threadStates}
        selectedThreadId={harness.selectedThreadId}
        viewMode={harness.viewMode}
        navigationLayout={harness.navigation.layout}
        threadSort={harness.navigation.sort}
        manualThreadOrder={harness.navigation.manualThreadOrder}
        creatingThread={Boolean(harness.busy.createThread)}
        archivingOldThreads={Boolean(harness.busy.archiveOldThreads)}
        onSelectThread={(threadId) => void harness.selectThread(threadId)}
        onSelectWorkspace={harness.setSelectedWorkspaceRoot}
        onArchiveOldThreads={() => void harness.archiveOldThreads()}
        onNewThread={() => void harness.createThread()}
        onChooseWorkspace={() => void harness.chooseWorkspace()}
        onSearch={(term) => void harness.searchThreads(term)}
        onRefresh={() => void harness.refresh()}
        onViewMode={(mode) => void harness.setViewMode(mode)}
        onNavigationLayout={harness.setNavigationLayout}
        onThreadSort={harness.setThreadSort}
        onManualThreadOrder={harness.setManualThreadOrder}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main-pane">
        {harness.currentThread ? (
          <>
            <ConversationHeader
              key={harness.currentThread.id}
              thread={harness.currentThread}
              workspace={workspace}
              archived={harness.viewMode === 'archived'}
              onRename={(name) => void harness.renameThread(harness.currentThread!.id, name)}
              onArchive={() => void harness.archiveThread(harness.currentThread!.id)}
              onUnarchive={() => void harness.unarchiveThread(harness.currentThread!.id)}
            />
            <div className="tab-bar">
              <div className="thread-tabs">
                <button type="button" className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}><MessageSquareText size={15} />对话</button>
                {pluginTabs.map((entry) => {
                  const contribution = entry.contribution
                  const tabId = pluginTabKey(entry.pluginId, contribution.id)
                  const Icon = contribution.icon
                  return (
                    <button key={tabId} type="button" className={tab === tabId ? 'active' : ''} onClick={() => setTab(tabId)}>
                      {Icon && <Icon size={15} />}{contribution.label}
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
                hasOlderTurns={Boolean(harness.currentDetail?.nextTurnsCursor)}
                loadingOlderTurns={Boolean(harness.busy.olderTurns)}
                onAnswerApproval={(request, decision) => void harness.answerApproval(request, decision)}
                onLoadOlderTurns={() => void harness.loadOlderTurns()}
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

            {harness.viewMode === 'active' && tab === 'chat' && (
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
                  disabled={harness.currentForeignActive || Boolean(harness.busy.composer)}
                  working={harness.isCurrentWorking}
                  foreignActive={harness.currentForeignActive}
                  busy={Boolean(harness.busy.composer)}
                  contextUsage={harness.currentTokenUsage}
                  onSend={harness.sendMessage}
                  onStop={harness.stopTurn}
                />
                <ConversationStats
                  turns={harness.currentDetail?.turns ?? []}
                  items={harness.currentDetail?.items ?? []}
                  tokenUsage={harness.currentTokenUsage}
                />
              </div>
            )}
          </>
        ) : <EmptyState hasWorkspaces={harness.workspaces.length > 0} onNewThread={() => void harness.createThread()} onWorkspace={() => void harness.chooseWorkspace()} />}
      </main>
      {settingsOpen && (
        <SettingsDialog
          fontSize={harness.appearance.fontSize}
          workspaces={harness.workspaces}
          threads={harness.threads}
          selectedThreadId={harness.selectedThreadId}
          onFontSize={harness.setFontSize}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {harness.toast && <div className={`toast ${harness.toast.kind}`}>{harness.toast.message}</div>}
    </div>
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
