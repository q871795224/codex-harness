// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadItemEntry } from '../../core/domain/codex'
import { TrajectoryView } from './TrajectoryView'
import { ToolCallDetails } from './ItemDetails'
import { writeClipboard } from '../markdown/clipboard'

vi.mock('../markdown/clipboard', () => ({ writeClipboard: vi.fn(async () => {}) }))
afterEach(cleanup)
const command = `/bin/zsh -lc '${'echo long-command; '.repeat(25)}echo END-OF-COMMAND'`
const items: ThreadItemEntry[] = [
  { turnId: 't1', item: { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'test', text_elements: [] }] } },
  { turnId: 't1', item: { id: 'cmd', type: 'commandExecution', command, status: 'completed', aggregatedOutput: 'RESULT-END', exitCode: 0, durationMs: 23 } },
  { turnId: 't2', item: { id: 'a', type: 'agentMessage', text: 'done' } },
]

it('opens full input/output details, switches tabs and returns keyboard focus', () => {
  render(<TrajectoryView items={items} hasEarlierTurns />)
  const row = screen.getByRole('row', { name: /第 1 轮 · 第 2 步/ })
  fireEvent.click(row)
  const drawer = screen.getByRole('complementary', { name: '步骤详情' })
  fireEvent.click(within(drawer).getByRole('tab', { name: '参数' }))
  expect(within(drawer).getByText(command).textContent).toBe(command)
  fireEvent.click(within(drawer).getByRole('tab', { name: '结果' }))
  expect(within(drawer).getByText('RESULT-END')).toBeTruthy()
  fireEvent.click(within(drawer).getByRole('tab', { name: 'Schema' }))
  expect(within(drawer).getByText(/未提供工具 Schema/)).toBeTruthy()
  fireEvent.click(within(drawer).getByRole('tab', { name: '计时' }))
  expect(within(drawer).getByText(/23 ms/)).toBeTruthy()
  expect(within(drawer).getByText('历史条目未提供步骤时间')).toBeTruthy()
  fireEvent.keyDown(drawer, { key: 'Escape' })
  expect(screen.queryByRole('complementary')).toBeNull()
  expect(document.activeElement).toBe(row)
})

it('uses one turn band for all messages in the turn and navigates from timeline', () => {
  render(<TrajectoryView items={items} />)
  const rows = screen.getAllByRole('row').slice(1)
  expect(rows[0].style.getPropertyValue('--turn-hue')).toBe(rows[2].style.getPropertyValue('--turn-hue'))
  expect(rows[0].style.getPropertyValue('--turn-hue')).not.toBe(rows[3].style.getPropertyValue('--turn-hue'))
  fireEvent.click(screen.getByRole('button', { name: '定位第 2 轮第 1 步' }))
  expect(screen.getByRole('complementary')).toBeTruthy()
})

it('updates the selected tool result while new output arrives', () => {
  const { rerender } = render(<TrajectoryView items={items} />)
  fireEvent.click(screen.getByRole('row', { name: /第 1 轮 · 第 3 步/ }))
  fireEvent.click(screen.getByRole('tab', { name: '结果' }))
  rerender(<TrajectoryView items={items.map((entry) => entry.item.id === 'cmd' ? { ...entry, item: { ...entry.item, aggregatedOutput: 'NEW-OUTPUT' } } : entry)} />)
  expect(within(screen.getByRole('tabpanel')).getByText('NEW-OUTPUT')).toBeTruthy()
})

it('copies the complete command including shell wrapper from conversation details', async () => {
  render(<ToolCallDetails item={items[1].item} />)
  fireEvent.click(screen.getAllByRole('button', { name: '复制代码' })[0])
  expect(writeClipboard).toHaveBeenCalledWith(command)
  expect(screen.getByText('RESULT-END')).toBeTruthy()
})
