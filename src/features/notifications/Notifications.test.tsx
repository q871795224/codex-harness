// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createNotificationStore } from '../../core/notifications/store'
import { NotificationCenter, NotificationViewport } from './Notifications'

afterEach(() => { cleanup(); vi.useRealTimers() })
function store() { return createNotificationStore({ load: async () => null, save: async () => undefined }) }

it('shows at most three readable floating notices, expires them, and keeps all history', async () => {
  vi.useFakeTimers()
  const notifications = store()
  await notifications.initialize()
  const onOpen = vi.fn()
  render(<NotificationViewport store={notifications} onOpen={onOpen} />)
  act(() => { for (let i = 0; i < 5; i++) notifications.publish({ level: 'error', source: '发布', title: `发布 ${i} 未完成`, details: 'RAW_STACK_TRACE' }) })
  expect(screen.getAllByRole('alert')).toHaveLength(3)
  expect(screen.queryByText('RAW_STACK_TRACE')).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: '查看详情' })[0])
  expect(onOpen).toHaveBeenCalledOnce()
  act(() => { vi.advanceTimersByTime(10001) })
  expect(screen.queryAllByRole('alert')).toHaveLength(0)
  expect(notifications.snapshot().records).toHaveLength(5)
})

it('opens a full page with filtering, expandable raw details, read state and source actions', async () => {
  const notifications = store()
  await notifications.initialize()
  const id = notifications.publish({ level: 'error', source: '发布', title: '发布未完成', details: 'RAW_ERROR', threadId: 'thread-a', actions: [{ kind: 'release-log', target: '/repo', runId: '123', label: '查看日志' }] })
  notifications.publish({ level: 'info', source: '快捷命令', title: 'VPN 已连接', threadId: 'thread-b' })
  const onAction = vi.fn(async () => undefined)
  const onBack = vi.fn()
  render(<NotificationCenter store={notifications} currentThreadId="thread-a" onBack={onBack} onAction={onAction} />)
  expect(screen.queryByText('RAW_ERROR')).toBeNull()
  fireEvent.change(screen.getByLabelText('通知范围'), { target: { value: 'thread' } })
  expect(screen.queryByText('VPN 已连接')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /发布未完成/ }))
  expect(screen.getByText('RAW_ERROR')).toBeTruthy()
  expect(notifications.snapshot().records.find((record) => record.id === id)?.read).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '查看日志' }))
  expect(onAction).toHaveBeenCalledWith({ kind: 'release-log', target: '/repo', runId: '123', label: '查看日志' })
  fireEvent.click(within(screen.getByRole('group', { name: '通知类型' })).getByRole('button', { name: '警告' }))
  expect(screen.getByText('没有符合筛选条件的通知')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返回会话' }))
  expect(onBack).toHaveBeenCalledOnce()
})

it.each(['pending', 'done'] as const)('keeps running notices visible until %s, then updates in place and expires', async (state) => {
  vi.useFakeTimers()
  const notifications = store()
  await notifications.initialize()
  render(<NotificationViewport store={notifications} onOpen={vi.fn()} />)
  let id = ''
  act(() => { id = notifications.publish({ level: 'info', source: '项目归档', title: '正在整理项目归档', state: 'running' }) })
  const toast = screen.getByRole('status')
  expect(toast.classList.contains('running')).toBe(true)
  expect(screen.getByLabelText('进行中')).toBeTruthy()
  expect(notifications.snapshot().records.filter((record) => !record.read)).toHaveLength(0)
  act(() => { vi.advanceTimersByTime(60000) })
  expect(screen.getByRole('status')).toBe(toast)
  // An ordinary toast still expires while the running one stays visible.
  act(() => { notifications.publish({ level: 'info', source: '测试', title: '普通通知' }) })
  act(() => { vi.advanceTimersByTime(5001) })
  expect(screen.queryByText('普通通知')).toBeNull()
  expect(screen.getByRole('status')).toBe(toast)
  const title = state === 'pending' ? '归档已就绪，等待确认' : '项目归档未完成'
  act(() => { notifications.publish({ id, level: state === 'pending' ? 'info' : 'error', source: '项目归档', title, state }) })
  expect(screen.getByText(title).closest('article')).toBe(toast)
  expect(screen.queryByLabelText('进行中')).toBeNull()
  expect(notifications.snapshot().records.filter((record) => record.id === id)).toHaveLength(1)
  expect(notifications.snapshot().records.find((record) => record.id === id)?.read).toBe(false)
  act(() => { vi.advanceTimersByTime(10001) })
  expect(screen.queryByText(title)).toBeNull()
})

it('keeps a dismissed task in the center and alerts again when ready', async () => {
  const notifications = store()
  await notifications.initialize()
  const id = notifications.publish({ level: 'info', source: '项目归档', title: '正在整理项目归档', state: 'running' })
  render(<><NotificationViewport store={notifications} onOpen={vi.fn()} /><NotificationCenter store={notifications} currentThreadId={null} onBack={vi.fn()} onAction={vi.fn()} /></>)
  fireEvent.click(screen.getByRole('button', { name: '关闭通知：正在整理项目归档' }))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByLabelText('进行中')).toBeTruthy()
  expect(screen.getByText('按最新时间排列 · 0 条未读')).toBeTruthy()
  act(() => { notifications.publish({ id, level: 'info', source: '项目归档', title: '归档已就绪，等待确认', state: 'pending' }) })
  expect(screen.getByRole('status')).toBeTruthy()
  expect(screen.getByText('按最新时间排列 · 1 条未读')).toBeTruthy()
  expect(notifications.snapshot().records).toHaveLength(1)
})
