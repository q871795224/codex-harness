// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueuedSubmission } from '../../core/domain/codex'
import { QueueDock } from './QueueDock'

afterEach(cleanup)

describe('QueueDock interactions', () => {
  it('expands a multi-item queue and saves an edited message with the keyboard', () => {
    const onEdit = vi.fn()
    renderDock({ onEdit })

    expect(screen.queryByText('second queued message')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /排队消息/ }))
    expect(screen.getByText('second queued message')).toBeTruthy()

    fireEvent.click(screen.getAllByTitle('修改排队消息')[0])
    const editor = screen.getByRole('textbox')
    fireEvent.change(editor, { target: { value: 'edited message' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

    expect(onEdit).toHaveBeenCalledWith('queue-1', 'edited message')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('only promotes while a turn is running and exposes manual queue start otherwise', () => {
    const onPromote = vi.fn()
    const onStart = vi.fn()
    const view = renderDock({ onPromote, onStart })

    fireEvent.click(screen.getByRole('button', { name: /排队消息/ }))
    expect(screen.getByRole('button', { name: '继续队列' })).toBeTruthy()
    expect((screen.getAllByTitle('运行中才能插话')[0] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '继续队列' }))
    expect(onStart).toHaveBeenCalledOnce()

    view.rerender(<QueueDock {...props({ working: true, onPromote, onStart })} />)
    expect(screen.queryByRole('button', { name: '继续队列' })).toBeNull()
    fireEvent.click(screen.getAllByTitle('改为插话')[0])
    expect(onPromote).toHaveBeenCalledWith(expect.objectContaining({ id: 'queue-1' }))
  })

  it('shows pending interjections even when the regular queue is empty', () => {
    render(<QueueDock {...props({
      queue: [],
      pendingSteers: [{
        clientUserMessageId: 'steer-1',
        text: 'urgent correction',
        input: [textInput('urgent correction')],
        createdAt: 1,
      }],
    })} />)

    expect(screen.getByText('urgent correction')).toBeTruthy()
    expect(screen.getByText(/等待下一次工具调用/)).toBeTruthy()
  })
})

function renderDock(overrides: Partial<ComponentProps<typeof QueueDock>> = {}) {
  return render(<QueueDock {...props(overrides)} />)
}

function props(overrides: Partial<ComponentProps<typeof QueueDock>> = {}): ComponentProps<typeof QueueDock> {
  return {
    queue: [queued('queue-1', 'first queued message'), queued('queue-2', 'second queued message')],
    pendingSteers: [],
    working: false,
    canMutate: true,
    busy: {},
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    onPromote: vi.fn(),
    onStart: vi.fn(),
    ...overrides,
  }
}

function queued(id: string, text: string): QueuedSubmission {
  return { id, clientUserMessageId: `message-${id}`, input: [textInput(text)] }
}

function textInput(text: string) {
  return { type: 'text' as const, text, text_elements: [] }
}
