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
