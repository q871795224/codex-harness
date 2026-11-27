// @vitest-environment jsdom
import { useState, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextConversationProvider, type ConversationProvider } from '../../core/domain/conversationProvider'
import type { Thread } from '../../core/domain/codex'
import { superbotThread, type SuperbotSession } from '../../core/superbot/types'
import { Sidebar } from './Sidebar'
afterEach(cleanup)
function props(): ComponentProps<typeof Sidebar> {
  return { workspaces: [], threads: [], threadRoots: {}, threadStates: {}, workingThreadIds: {}, selectedThreadId: null,
    viewMode:'active', navigationLayout:'list', threadSort:'recent', workspaceSort:'stable', manualThreadOrder:[], pinnedThreadIds:[], pinnedWorkspaceRoots:[],
    sidebarWidth:280, sidebarCollapsed:false, sidebarListSplitRatio:.5, creatingThread:false, archivingOldThreads:false, newThreadProvider:'codex',
    onNewThread:vi.fn(), onToggleNewThreadProvider:vi.fn(), onSelectThread:vi.fn(), onSelectWorkspace:vi.fn(), onArchiveOldThreads:vi.fn(),onSearch:vi.fn(),onRefresh:vi.fn(),onViewMode:vi.fn(),onNavigationLayout:vi.fn(),onThreadSort:vi.fn(),onWorkspaceSort:vi.fn(),onManualThreadOrder:vi.fn(),onToggleThreadPinned:vi.fn(),onToggleWorkspacePinned:vi.fn(),onSidebarWidth:vi.fn(),onSidebarListSplitRatio:vi.fn(),onOpenSettings:vi.fn(),onOpenPlugins:vi.fn(),onVisibleThreadOrder:vi.fn() }
}
describe('sidebar conversation controls', () => {
  it('uses archive time inside both pin groups even when active sessions use manual ordering', () => {
    const base = props()
    const now = Math.floor(Date.now() / 1000)
    const thread = (id: string, archivedAt: number, recencyAt: number): Thread => ({
      id, name: id, preview: '', cwd: '/repo', createdAt: 1, updatedAt: recencyAt, recencyAt, archivedAt,
      status: { type: 'idle' }, ephemeral: false, canAcceptDirectInput: false,
    })
    const threads = [
      thread('old-unpinned', now - 864000, now), thread('old-pinned', now - 864000, now),
      thread('new-unpinned', now - 60, 1), thread('new-pinned', now - 60, 1),
    ]
    const { container, rerender } = render(<Sidebar {...base} viewMode="archived" threads={threads} threadSort="manual"
      manualThreadOrder={threads.map(t => t.id)} pinnedThreadIds={['old-pinned', 'new-pinned']} />)
    const order = () => [...container.querySelectorAll('[data-thread-sort-id]')].map(row => row.getAttribute('data-thread-sort-id'))
    expect(order()).toEqual(['new-pinned', 'old-pinned', 'new-unpinned', 'old-unpinned'])
    expect(container.querySelectorAll('.manual-sort')).toHaveLength(0)
    expect(container.querySelectorAll('time[title="归档时间"]')).toHaveLength(4)
    expect(base.onVisibleThreadOrder).toHaveBeenLastCalledWith(['new-pinned', 'old-pinned', 'new-unpinned', 'old-unpinned'])
    rerender(<Sidebar {...base} viewMode="active" threads={threads} threadSort="manual"
      manualThreadOrder={threads.map(t => t.id)} pinnedThreadIds={['old-pinned', 'new-pinned']} />)
    expect(order()).toEqual(['old-pinned', 'new-pinned', 'old-unpinned', 'new-unpinned'])
  })

  it('switches providers with the icon button and creates the currently selected type', () => {
    const base = props()
    function Controlled() {
      const [provider, choose] = useState<ConversationProvider>('codex')
      return <Sidebar {...base} newThreadProvider={provider} claudeStatus={{available:true} as NonNullable<ComponentProps<typeof Sidebar>['claudeStatus']>} onToggleNewThreadProvider={() => choose(p => nextConversationProvider(p, true))} />
    }
    render(<Controlled />)
    expect(screen.queryByRole('combobox', { name:'新会话类型' })).toBeNull()
    expect(screen.getByAltText('Codex')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name:'切换到 Claude 新会话' }))
    fireEvent.click(screen.getByRole('button', { name:'新会话' }))
    expect(base.onNewThread).toHaveBeenLastCalledWith('claude')
    fireEvent.click(screen.getByRole('button', { name:'切换到 Superbot 新会话' }))
    fireEvent.click(screen.getByRole('button', { name:'新会话' }))
    expect(base.onNewThread).toHaveBeenLastCalledWith('superbot')
    fireEvent.click(screen.getByRole('button', { name:'切换到 Codex 新会话' }))
    expect(screen.getByAltText('Codex')).toBeTruthy()
  })
  it('creates a relay conversation from its own entry and marks relay rows', () => {
    const onNewRelayThread = vi.fn()
    const relay: Thread = { id:'relay', name:'发布协调', preview:'', cwd:'/data/workspaces/relay', createdAt:1, updatedAt:1, recencyAt:1,
      status:{ type:'idle' }, ephemeral:false, canAcceptDirectInput:false, harnessRelay:true }
    render(<Sidebar {...props()} threads={[relay]} onNewRelayThread={onNewRelayThread} />)
    fireEvent.click(screen.getByRole('button', { name:'新建路由会话' }))
    expect(onNewRelayThread).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('路由会话')).toBeTruthy()
  })
  it('keeps the short Superbot group label and identifies SeaTalk sessions', () => {
    const base = props()
    const normal = { id:'normal', title:'Normal chat', status:'active',read_only:false, created_at:'2026-11-17T08:00:00Z',updated_at:'2026-11-17T08:00:00Z' } as SuperbotSession
    const seatalk = { ...normal, id:'seatalk', title:'SeaTalk chat', seatalk_kind:'thread' as const }
    render(<Sidebar {...base} threads={[superbotThread(normal),superbotThread(seatalk)]} />)
    expect(screen.getByText('Superbot', { exact:true })).toBeTruthy()
    expect(screen.queryByText('Superbot · 公司云端')).toBeNull()
    fireEvent.click(screen.getByLabelText('SeaTalk 会话').closest('button')!)
    expect(base.onSelectThread).toHaveBeenCalledWith('superbot:seatalk')
  })
})
