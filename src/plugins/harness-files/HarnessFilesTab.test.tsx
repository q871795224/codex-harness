// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessFilesTab, organizeTree } from './index'
import type { HarnessFileNode, HarnessFilesService } from '../../core/harness-files/types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
function node(path: string, source: HarnessFileNode['source'], children?: HarnessFileNode[]): HarnessFileNode {
  return { path, name: path.split('/').pop()!, source, kind: children ? 'directory' : 'file', exists: true, instructionStatus: null, children: children ?? [] }
}
it('uses real directories and nests .harness inside its workspace', () => {
  const local = node('/repo/.harness', 'harness', [node('/repo/.harness/README.md', 'harness')])
  const tree = organizeTree({ cwd: '/repo', projectRoot: '/repo', roots: [
    node('/home/.codex', 'global', []),
    node('/repo/.', 'project', [node('/repo', 'project', [node('/repo/AGENTS.md', 'project')])]), local,
    node('/home/.codex-harness/memory', 'memory', []),
  ] })
  expect(tree.roots.map((root) => root.name)).toEqual(['harness', 'memory'])
  expect(tree.roots[0].virtual).toBe(true)
  expect(tree.roots[0].children.map((root) => root.name)).toEqual(['/home/.codex', '/repo'])
  expect(tree.roots[0].children[1].children[1]).toBe(local)
})
it('edits memory with a version check, preserves failed drafts and reloads on refresh', async () => {
  let disk = 'original'
  const memory = node('/data/memory/global/MEMORY.md', 'memory')
  const write = vi.fn(async () => { throw new Error('记忆文件已被其他操作修改') })
  const files: HarnessFilesService = {
    configurationKey: () => '', list: async () => ({ cwd: '/repo', projectRoot: '/repo', roots: [node('/data/memory', 'memory', [memory])] }),
    read: async () => disk, write, createDirectory: vi.fn(), rename: vi.fn(), remove: vi.fn(),
  }
  const { container } = render(<HarnessFilesTab files={files} context={{ threadId: 't', threadCwd: '/repo', workspaceRoot: '/repo', items: [], workspaces: [], threads: [] }} />)
  const editor = await screen.findByRole('textbox')
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('original'))
  expect(container.textContent).not.toContain('THREAD FILES')
  expect(container.querySelector('.harness-editor-meta')).toBeNull()
  expect(screen.getByTitle('repo')).toBeTruthy()
  fireEvent.change(editor, { target: { value: 'draft' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByText('记忆文件已被其他操作修改')
  expect(write).toHaveBeenCalledWith('/repo', memory.path, 'draft', 'codex', 'original')
  expect((editor as HTMLTextAreaElement).value).toBe('draft')
  disk = 'changed outside'
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  fireEvent.click(screen.getByTitle('刷新文件树'))
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe(disk))
})

it('toggles draft Markdown before rename/delete, preserves text, and saves from preview', async () => {
  const path = '/repo/AGENTS.md'
  let disk = '# Original'
  const write = vi.fn(async (_cwd: string, _path: string, content: string) => { disk = content })
  const files: HarnessFilesService = {
    configurationKey: () => '', list: async () => ({ cwd: '/repo', projectRoot: '/repo', roots: [node('/repo/.', 'project', [node('/repo', 'project', [node(path, 'project')])])] }),
    read: async () => disk, write, createDirectory: vi.fn(), rename: vi.fn(), remove: vi.fn(),
  }
  render(<HarnessFilesTab files={files} context={{ threadId: 't', threadCwd: '/repo', workspaceRoot: '/repo', items: [], workspaces: [], threads: [] }} />)
  const editor = await screen.findByRole('textbox')
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe(disk))
  const draft = '# Draft\n\n**Important**\n\n| Key | Value |\n| --- | --- |\n| a | b |'
  fireEvent.change(editor, { target: { value: draft } })
  const toggle = screen.getByRole('button', { name: '切换为 Markdown 预览' })
  expect(toggle.nextElementSibling).toBe(screen.getByTitle('重命名'))
  fireEvent.click(toggle)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Draft' })).toBeTruthy()
  expect(screen.getByRole('table')).toBeTruthy()
  expect(write).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '切换为普通文本' }))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(draft)
  fireEvent.click(screen.getByRole('button', { name: '切换为 Markdown 预览' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(write).toHaveBeenCalledWith('/repo', path, draft, 'codex', '# Original'))
  expect(await screen.findByRole('status')).toBeTruthy()
})
