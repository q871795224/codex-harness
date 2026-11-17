// @vitest-environment jsdom
import { useState } from 'react'
import type { ComposerDraft } from '../conversation/Composer'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import type { SuperbotSnapshot } from '../../core/superbot/types'
import { SuperbotView } from './SuperbotView'
import type { useSuperbotHarness } from './useSuperbotHarness'
vi.mock('../../core/runtime/bridge', () => ({ runtime: { getAppState: vi.fn().mockResolvedValue(null), setAppState: vi.fn().mockResolvedValue(undefined), pasteComposerImage: vi.fn(), chooseComposerFiles: vi.fn(), openExternalUrl: vi.fn().mockResolvedValue(undefined), readMarkdownImage: vi.fn() } }))
const session = { id: 'remote', title: 'Test Superbot', status: 'active', read_only: false, runtime_id: 'cloud', run_config: {}, created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T08:00:00Z' }
const snapshot: SuperbotSnapshot = { session, page: { messages: [], has_more: false, next_cursor: null }, pending: {}, events: [] }
let service: ReturnType<typeof useSuperbotHarness>
const onDraft = vi.fn()
function props() { return { id: 'superbot:remote', session, snapshot, service, codexSettings: { model: '', effort: '', serviceTier: null, approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, sandboxMode: 'danger-full-access' as const }, draft: { text: 'hello', attachments: [], collapsedPastes: [] }, onDraft, draftReady: true, sendShortcut: 'mod-enter' as const } }
beforeEach(() => {
  vi.clearAllMocks()
  service = { catalog: vi.fn().mockResolvedValue(undefined), read: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn(), send: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), archive: vi.fn(), rename: vi.fn(), models: [{ id: 'opus', label: 'Opus', thinking: { supported_levels: [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }], default_level: 'high' } }], error: null, busy: false } as unknown as typeof service
})
afterEach(cleanup)

describe('Superbot conversation controls', () => {
  it('waits for saved drafts before mounting the shared composer', () => {
    const { rerender } = render(<SuperbotView {...props()} draftReady={false} draft={undefined} />)
    expect(screen.queryByPlaceholderText('给 Superbot 发送消息')).toBeNull()
    expect(onDraft).not.toHaveBeenCalled()
    rerender(<SuperbotView {...props()} draftReady draft={{ text: 'restored draft', attachments: [], collapsedPastes: [] }} />)
    expect((screen.getByPlaceholderText('给 Superbot 发送消息') as HTMLTextAreaElement).value).toBe('restored draft')
  })

  it('round-trips a controlled draft without resetting input or causing render loops', () => {
    function Controlled() {
      const [draft, update] = useState<ComposerDraft>(props().draft)
      return <SuperbotView {...props()} draft={draft} onDraft={update} />
    }
    render(<Controlled />)
    fireEvent.change(screen.getByPlaceholderText('给 Superbot 发送消息'), { target: { value: 'updated' } })
    expect((screen.getByPlaceholderText('给 Superbot 发送消息') as HTMLTextAreaElement).value).toBe('updated')
  })

  it('uses the shared header, transcript, tabs and composer without local-only controls', () => {
    const { container } = render(<SuperbotView {...props()} />)
    for (const selector of ['.thread-header', '.thread-tabs', '.conversation-pane', '.composer-card', '.model-effort-control']) expect(container.querySelector(selector)).toBeTruthy()
    expect(container.querySelector('.superbot-composer')).toBeNull()
    expect(screen.queryByRole('button', { name: '添加图片或文件' })).toBeNull()
    expect(screen.queryByLabelText('审批模式')).toBeNull()
    expect(screen.queryByLabelText('切换 YOLO 模式')).toBeNull()
    expect(screen.queryByLabelText('切换新会话工作区')).toBeNull()
  })
  it('does not read a pasted image from the local clipboard', () => {
    render(<SuperbotView {...props()} />)
    fireEvent.paste(screen.getByPlaceholderText('给 Superbot 发送消息'), { clipboardData: { items: [{ kind: 'file', type: 'image/png' }], getData: () => '' } })
    expect(runtime.pasteComposerImage).not.toHaveBeenCalled()
  })

  it('passes the selected model and thinking level and clears an accepted draft', async () => {
    render(<SuperbotView {...props()} />)
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: 'opus' } })
    fireEvent.change(screen.getByLabelText('Superbot 推理强度'), { target: { value: 'max' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(service.send).toHaveBeenCalledWith('superbot:remote', 'hello', { model: 'opus', thinking_level: 'max' }))
    await waitFor(() => expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: '' })))
  })
  it('sends the server reset flag when returning to the default model', async () => {
    render(<SuperbotView {...props()} />)
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: 'opus' } })
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(service.send).toHaveBeenCalledWith('superbot:remote', 'hello', { reset: true }))
  })
  it('preserves the draft when the send result is unknown', async () => {
    vi.mocked(service.send).mockRejectedValue(new Error('结果未知，请刷新核对'))
    render(<SuperbotView {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('结果未知'))
    expect((screen.getByPlaceholderText('给 Superbot 发送消息') as HTMLTextAreaElement).value).toBe('hello')
  })
  it('preserves text edited while a message was being sent', async () => {
    let accept!: () => void
    vi.mocked(service.send).mockReturnValue(new Promise<void>(resolve => { accept = resolve }))
    const { rerender } = render(<SuperbotView {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    fireEvent.change(screen.getByPlaceholderText('给 Superbot 发送消息'), { target: { value: 'next message' } })
    rerender(<SuperbotView {...props()} />)
    await act(async () => accept())
    expect((screen.getByPlaceholderText('给 Superbot 发送消息') as HTMLTextAreaElement).value).toBe('next message')
  })
  it('shows the active task and stops only this session', async () => {
    render(<SuperbotView {...props()} snapshot={{ ...snapshot, pending: { task_id: 'task', status: 'running' }, events: [{ seq: 1, type: 'tool_use', tool: 'Bash', input: { command: 'pwd' } }] }} />)
    expect(screen.getByRole('button', { name: /Superbot 正在执行/ })).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    expect((screen.getByLabelText('Superbot 模型') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '停止当前回合' }))
    await waitFor(() => expect(service.stop).toHaveBeenCalledWith('superbot:remote'))
  })
  it('renders remote file references without opening or reading local files', async () => {
    render(<SuperbotView {...props()} snapshot={{ ...snapshot, page: { ...snapshot.page, messages: [{ id: 'm', role: 'assistant', content: '[file](/etc/private)\n\n![image](/etc/private.png)', created_at: session.created_at }] } }} />)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByText('file'))
    expect(runtime.openExternalUrl).not.toHaveBeenCalled()
    expect(runtime.readMarkdownImage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '在 Collab 打开' }))
    await waitFor(() => expect(runtime.openExternalUrl).toHaveBeenCalledWith('https://collab.shopee.io/naming/chat?session=remote'))
  })
  it('disables sending in active read-only sessions', () => {
    render(<SuperbotView {...props()} session={{ ...session, read_only: true }} />)
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('hides the shared composer in archived sessions', () => {
    render(<SuperbotView {...props()} session={{ ...session, status: 'archived' }} />)
    expect(screen.queryByPlaceholderText('给 Superbot 发送消息')).toBeNull()
    expect(screen.getByTitle('恢复会话')).toBeTruthy()
  })
})
