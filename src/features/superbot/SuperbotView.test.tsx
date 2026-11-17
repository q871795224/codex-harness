// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import type { SuperbotSnapshot } from '../../core/superbot/types'
import { SuperbotView } from './SuperbotView'
import type { useSuperbotHarness } from './useSuperbotHarness'
vi.mock('../../core/runtime/bridge', () => ({ runtime: { openExternalUrl: vi.fn().mockResolvedValue(undefined), readMarkdownImage: vi.fn() } }))
const session = { id: 'remote', title: 'Test Superbot', status: 'active', read_only: false, runtime_id: 'cloud', run_config: {}, created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T08:00:00Z' }
const snapshot: SuperbotSnapshot = { session, page: { messages: [], has_more: false, next_cursor: null }, pending: {}, events: [] }
let service: ReturnType<typeof useSuperbotHarness>
const onDraft = vi.fn()
function props() { return { id: 'superbot:remote', session, snapshot, service, draft: 'hello', onDraft, draftReady: true, sendShortcut: 'mod-enter' as const } }
beforeEach(() => {
  vi.clearAllMocks()
  service = { catalog: vi.fn().mockResolvedValue(undefined), read: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn(), send: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), archive: vi.fn(), rename: vi.fn(), models: [{ id: 'opus', label: 'Opus', thinking: { supported_levels: [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }], default_level: 'high' } }], error: null, busy: false } as unknown as typeof service
})
afterEach(cleanup)

describe('Superbot conversation controls', () => {
  it('passes the selected model and thinking level and clears an accepted draft', async () => {
    render(<SuperbotView {...props()} />)
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: 'opus' } })
    fireEvent.change(screen.getByLabelText('Superbot 推理强度'), { target: { value: 'max' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(service.send).toHaveBeenCalledWith('superbot:remote', 'hello', { model: 'opus', thinking_level: 'max' }))
    expect(onDraft).toHaveBeenCalledWith('')
  })
  it('sends the server reset flag when returning to the default model', async () => {
    render(<SuperbotView {...props()} />)
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: 'opus' } })
    fireEvent.change(screen.getByLabelText('Superbot 模型'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(service.send).toHaveBeenCalledWith('superbot:remote', 'hello', { reset: true }))
  })
  it('preserves the draft when the send result is unknown', async () => {
    vi.mocked(service.send).mockRejectedValue(new Error('结果未知，请刷新核对'))
    render(<SuperbotView {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('结果未知'))
    expect(onDraft).not.toHaveBeenCalled()
  })
  it('preserves text edited while a message was being sent', async () => {
    let accept!: () => void
    vi.mocked(service.send).mockReturnValue(new Promise<void>(resolve => { accept = resolve }))
    const { rerender } = render(<SuperbotView {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    rerender(<SuperbotView {...props()} draft="next message" />)
    await act(async () => accept())
    expect(onDraft).not.toHaveBeenCalled()
  })
  it('shows the active task and stops only this session', async () => {
    render(<SuperbotView {...props()} snapshot={{ ...snapshot, pending: { task_id: 'task', status: 'running' }, events: [{ seq: 1, type: 'tool_use', tool: 'Bash', input: { command: 'pwd' } }] }} />)
    expect(screen.getByRole('status').textContent).toContain('云端执行')
    expect(screen.getByText('Bash')).toBeTruthy()
    expect((screen.getByLabelText('Superbot 模型') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
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
  it('disables sending in archived and read-only sessions', () => {
    render(<SuperbotView {...props()} session={{ ...session, status: 'archived' }} />)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('发送给 Superbot 的消息') as HTMLTextAreaElement).disabled).toBe(true)
  })
})
