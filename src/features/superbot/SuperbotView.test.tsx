// @vitest-environment jsdom
import { useState, type ComponentProps } from 'react'
import type { ComposerDraft } from '../conversation/Composer'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { DEFAULT_SUPERBOT_CONFIG, type SuperbotSnapshot } from '../../core/superbot/types'
import { SuperbotView } from './SuperbotView'
import type { useSuperbotHarness } from './useSuperbotHarness'
vi.mock('../../core/runtime/bridge', () => ({ runtime: { getAppState: vi.fn().mockResolvedValue(null), setAppState: vi.fn().mockResolvedValue(undefined), pasteComposerImage: vi.fn(), chooseComposerFiles: vi.fn(), openExternalUrl: vi.fn().mockResolvedValue(undefined), readMarkdownImage: vi.fn(), validateComposerImage: vi.fn().mockResolvedValue(undefined) } }))
const session = { id: 'remote', title: 'Test Superbot', status: 'active', read_only: false, runtime_id: 'cloud', run_config: {}, created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T08:00:00Z' }
const snapshot: SuperbotSnapshot = { session, page: { messages: [], has_more: false, next_cursor: null }, pending: {}, events: [] }
let service: ReturnType<typeof useSuperbotHarness>
const onDraft = vi.fn()
function props() { return { id: 'superbot:remote', session, snapshot, service, codexSettings: { model: '', effort: '', serviceTier: null, approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, sandboxMode: 'danger-full-access' as const }, draft: { text: 'hello', attachments: [], collapsedPastes: [] }, onDraft, draftReady: true, sendShortcut: 'mod-enter' as const } }
function TestView(props: ComponentProps<typeof SuperbotView>) {
  const [settings, setSettings] = useState(DEFAULT_SUPERBOT_CONFIG)
  return <SuperbotView {...props} service={{ ...props.service, settingsForThread: () => settings, updateSettings: (_id, next) => setSettings(next) }} />
}
beforeEach(() => {
  vi.clearAllMocks()
  service = { onMessageAccepted: vi.fn(() => () => {}), queuedAction: vi.fn().mockResolvedValue(undefined), catalog: vi.fn().mockResolvedValue(undefined), read: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn(), send: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), archive: vi.fn(), rename: vi.fn(), models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', thinking: { supported_levels: [{ value: 'medium', label: 'medium' }], default_level: 'medium' } }, { id: 'opus', label: 'Opus', thinking: { supported_levels: [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }], default_level: 'high' } }], error: null, busy: false } as unknown as typeof service
})
afterEach(cleanup)

describe('Superbot conversation controls', () => {
  it('waits for saved drafts before mounting the shared composer', () => {
    const { rerender } = render(<TestView {...props()} draftReady={false} draft={undefined} />)
    expect(screen.queryByPlaceholderText('给 Superbot 发送消息')).toBeNull()
    expect(onDraft).not.toHaveBeenCalled()
    rerender(<TestView {...props()} draftReady draft={{ text: 'restored draft', attachments: [], collapsedPastes: [] }} />)
    expect((screen.getByPlaceholderText('给 Superbot 发送消息') as HTMLTextAreaElement).value).toBe('restored draft')
  })

  it('round-trips a controlled draft without resetting input or causing render loops', () => {
    function Controlled() {
      const [draft, update] = useState<ComposerDraft>(props().draft)
      return <TestView {...props()} draft={draft} onDraft={update} />
    }
    render(<Controlled />)
    fireEvent.change(screen.getByPlaceholderText('给 Superbot 发送消息'), { target: { value: 'updated' } })
    expect((screen.getByPlaceholderText('给 Superbot 发送消息') as HTMLTextAreaElement).value).toBe('updated')
  })

  it('uses the shared header, transcript, tabs and composer without local-only controls', () => {
    const { container } = render(<TestView {...props()} />)
    for (const selector of ['.thread-header', '.thread-tabs', '.conversation-pane', '.composer-card', '.model-effort-control']) expect(container.querySelector(selector)).toBeTruthy()
    expect(container.querySelector('.superbot-composer')).toBeNull()
    expect(screen.getByRole('button', { name: '添加图片或文件' })).toBeTruthy()
    expect(screen.queryByLabelText('审批模式')).toBeNull()
    expect(screen.queryByLabelText('切换 YOLO 模式')).toBeNull()
    expect(screen.queryByLabelText('切换新会话工作区')).toBeNull()
  })
  it('does not offer uploads in SeaTalk conversations', () => {
    render(<TestView {...props()} session={{ ...session, seatalk_kind: 'thread' }} />)
    expect(screen.queryByRole('button', { name: '添加图片或文件' })).toBeNull()
    fireEvent.paste(screen.getByPlaceholderText('给 Superbot 发送消息'), { clipboardData: { items: [{ kind: 'file', type: 'image/png' }], getData: () => '' } })
    expect(runtime.pasteComposerImage).not.toHaveBeenCalled()
  })

  it('passes the selected model and thinking level and clears an accepted draft', async () => {
    render(<TestView {...props()} />)
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: 'opus' } })
    fireEvent.change(screen.getByLabelText('Superbot 推理强度'), { target: { value: 'max' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(service.send).toHaveBeenCalledWith('superbot:remote', 'hello', { model: 'opus', thinking_level: 'max' }, [], 'queue'))
    await waitFor(() => expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: '' })))
  })
  it('sends the server reset flag when returning to the default model', async () => {
    render(<TestView {...props()} />)
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: 'opus' } })
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(service.send).toHaveBeenCalledWith('superbot:remote', 'hello', { reset: true }, [], 'queue'))
  })
  it('preserves the draft when the send result is unknown', async () => {
    vi.mocked(service.send).mockRejectedValue(new Error('结果未知，请刷新核对'))
    render(<TestView {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('结果未知'))
    expect((screen.getByPlaceholderText('给 Superbot 发送消息') as HTMLTextAreaElement).value).toBe('hello')
  })
  it('preserves text edited while a message was being sent', async () => {
    let accept!: () => void
    vi.mocked(service.send).mockReturnValue(new Promise<void>(resolve => { accept = resolve }))
    const { rerender } = render(<TestView {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    fireEvent.change(screen.getByPlaceholderText('给 Superbot 发送消息'), { target: { value: 'next message' } })
    rerender(<TestView {...props()} />)
    await act(async () => accept())
    expect((screen.getByPlaceholderText('给 Superbot 发送消息') as HTMLTextAreaElement).value).toBe('next message')
  })
  it('shows the active task and stops only this session', async () => {
    render(<TestView {...props()} snapshot={{ ...snapshot, pending: { task_id: 'task', status: 'running' }, events: [{ seq: 1, type: 'tool_use', tool: 'Bash', input: { command: 'pwd' } }] }} />)
    expect(screen.getByRole('button', { name: /Superbot 正在执行/ })).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    expect((screen.getByLabelText('Superbot 模型') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '停止当前回合' }))
    await waitFor(() => expect(service.stop).toHaveBeenCalledWith('superbot:remote'))
  })
  it('renders remote file references without opening or reading local files', async () => {
    render(<TestView {...props()} snapshot={{ ...snapshot, page: { ...snapshot.page, messages: [{ id: 'm', role: 'assistant', content: '[file](/etc/private)\n\n![image](/etc/private.png)', created_at: session.created_at }] } }} />)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByText('file'))
    expect(runtime.openExternalUrl).not.toHaveBeenCalled()
    expect(runtime.readMarkdownImage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '在 Collab 打开' }))
    await waitFor(() => expect(runtime.openExternalUrl).toHaveBeenCalledWith('https://collab.shopee.io/naming/chat?session=remote'))
  })
  it('disables sending in active read-only sessions', () => {
    render(<TestView {...props()} session={{ ...session, read_only: true }} />)
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('hides the shared composer in archived sessions', () => {
    render(<TestView {...props()} session={{ ...session, status: 'archived' }} />)
    expect(screen.queryByPlaceholderText('给 Superbot 发送消息')).toBeNull()
    expect(screen.getByTitle('恢复会话')).toBeTruthy()
  })
  it('offers pin, unpin, archive and restore through the shared header', async () => {
    const toggle = vi.fn(); const archive = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<TestView {...props()} onTogglePinned={toggle} onArchive={archive} />)
    fireEvent.click(screen.getByTitle('置顶会话'))
    expect(toggle).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('归档会话'))
    await waitFor(() => expect(archive).toHaveBeenCalledWith(true))
    rerender(<TestView {...props()} pinned onTogglePinned={toggle} onArchive={archive} session={{ ...session, status: 'archived' }} />)
    fireEvent.click(screen.getByTitle('取消置顶会话'))
    expect(toggle).toHaveBeenCalledTimes(2)
    expect((screen.getByTitle('恢复会话') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTitle('恢复会话'))
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith(false))
  })

  it('shows available cloud repository and configured branch without local workspace controls', () => {
    render(<TestView {...props()} session={{ ...session, repository_context: { git: [{ url: 'https://git.example/team/service.git', base_branch: 'main' }] } }}
      snapshot={snapshot} />)
    expect(screen.getByText('公司云端 · naming · service · main')).toBeTruthy()
    expect(screen.queryByTitle(/点击切换 checkout/)).toBeNull()
  })

  it('uploads selected images and files rather than inserting local file paths into cloud text', async () => {
    vi.mocked(runtime.chooseComposerFiles).mockResolvedValue(['/tmp/chart.png', '/tmp/report.pdf'])
    render(<TestView {...props()} />)
    expect((screen.getByLabelText('Superbot 模型') as HTMLSelectElement).value).toBe('claude-opus-5-5')
    expect((screen.getByLabelText('Superbot 推理强度') as HTMLSelectElement).value).toBe('medium')
    fireEvent.click(screen.getByRole('button', { name: '添加图片或文件' }))
    await screen.findByRole('button', { name: '移除 report.pdf' })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(service.send).toHaveBeenCalledWith('superbot:remote', 'hello', DEFAULT_SUPERBOT_CONFIG, ['/tmp/chart.png', '/tmp/report.pdf'], 'queue'))
  })

  it('queues follow-ups while running, and switches to interjection when the server permits it', async () => {
    render(<TestView {...props()} snapshot={{ ...snapshot, pending: { task_id: 'task', status: 'running', supports_queue: true, can_guide: true } }} />)
    expect((screen.getByTitle('归档会话') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '排队消息' }))
    await waitFor(() => expect(service.send).toHaveBeenLastCalledWith('superbot:remote', 'hello', DEFAULT_SUPERBOT_CONFIG, [], 'queue'))
    fireEvent.change(screen.getByPlaceholderText('给 Superbot 发送消息'), { target: { value: 'new direction' } })
    fireEvent.click(screen.getByRole('button', { name: '选择后续消息默认行为' }))
    fireEvent.click(screen.getByRole('button', { name: /默认插话/ }))
    fireEvent.click(screen.getByRole('button', { name: '插话' }))
    await waitFor(() => expect(service.send).toHaveBeenLastCalledWith('superbot:remote', 'new direction', DEFAULT_SUPERBOT_CONFIG, [], 'interject'))
  })

  it('shows remote queued messages and routes removal and promotion to this conversation', async () => {
    render(<TestView {...props()} snapshot={{ ...snapshot, pending: { task_id: 'task', supports_queue: true, can_guide: true,
      queued_tasks: [{ task_id: 'queued', status: 'queued', content: 'follow up' }] } }} />)
    expect(screen.getByText('follow up')).toBeTruthy()
    expect(screen.queryByTitle('修改排队消息')).toBeNull()
    fireEvent.click(screen.getByTitle('撤回排队消息'))
    await waitFor(() => expect(service.queuedAction).toHaveBeenCalledWith('superbot:remote', 'queued', 'remove'))
    fireEvent.click(screen.getByTitle('改为插话'))
    await waitFor(() => expect(service.queuedAction).toHaveBeenCalledWith('superbot:remote', 'queued', 'steer'))
  })

  it('disables interjection until cloud guidance is ready', () => {
    render(<TestView {...props()} snapshot={{ ...snapshot, pending: { task_id: 'task', supports_queue: true, can_guide: false } }} />)
    fireEvent.click(screen.getByRole('button', { name: '选择后续消息默认行为' }))
    expect((screen.getByRole('button', { name: /默认插话/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers the shared delayed-send menu without immediately sending', () => {
    const schedule = vi.fn()
    render(<TestView {...props()} onScheduleSend={schedule} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '发送消息' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '5 分钟后发送' }))
    expect(schedule).toHaveBeenCalledWith(5, [{ type: 'text', text: 'hello', text_elements: [] }], 'queue', [], 'hello')
    expect(service.send).not.toHaveBeenCalled()
  })

  it('renders an attachment-only remote message using a cloud link', async () => {
    const attachment = { id: '00000000-0000-4000-8000-000000000001', filename: 'chart.png', content_type: 'image/png' }
    render(<TestView {...props()} snapshot={{ ...snapshot, page: { ...snapshot.page, messages: [{ id: 'm', role: 'user', content: '', attachments: [attachment], created_at: session.created_at }] } }} />)
    fireEvent.click(screen.getByRole('button', { name: '[chart.png]' }))
    expect(runtime.openExternalUrl).toHaveBeenCalledWith('https://collab.shopee.io/api/attachments/00000000-0000-4000-8000-000000000001/download?workspace_slug=naming')
    expect(runtime.readMarkdownImage).not.toHaveBeenCalled()
  })

})
