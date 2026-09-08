// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { notifications } from '../notifications/service'
import { QuickCommandPanel } from './QuickCommandPanel'

afterEach(cleanup)
it('retains a command failure after the panel closes and separates raw errors from visible text', async () => {
  let reject!: (error: Error) => void
  const run = vi.fn(() => new Promise<{ success: boolean; message: string }>((_resolve, fail) => { reject = fail }))
  render(<QuickCommandPanel threadId="thread-notifications" workspaceRoot="/repo" commands={[{ pluginId: 'test', instanceId: 'test', contribution: { id: 'test', label: '连接 VPN', command: 'vpn-on', run } }]} />)
  fireEvent.click(screen.getByRole('button', { name: '打开快捷命令' }))
  fireEvent.click(screen.getByRole('button', { name: '连接 VPN：vpn-on' }))
  fireEvent.click(screen.getByRole('button', { name: '快捷命令面板，点击收起' }))
  reject(new Error('RAW_COMMAND_FAILURE'))
  await waitFor(() => expect(notifications.snapshot().records.find((record) => record.threadId === 'thread-notifications')?.state).toBe('done'))
  const record = notifications.snapshot().records.find((item) => item.threadId === 'thread-notifications')!
  expect(record).toMatchObject({ level: 'error', title: '连接 VPN：未完成', workspaceRoot: '/repo' })
  expect(record.details).toContain('RAW_COMMAND_FAILURE')
  fireEvent.click(screen.getByRole('button', { name: '打开快捷命令' }))
  expect(screen.queryByText('RAW_COMMAND_FAILURE')).toBeNull()
})
