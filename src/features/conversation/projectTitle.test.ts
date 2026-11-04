import { expect, it, vi } from 'vitest'
import type { ProjectMeta } from '../project-doc/types'
import type { ThreadProjectBinding } from '../../core/project-docs/types'
import { titleSourceText, insertCollapsedPaste } from './composerInput'
import { threadTitlePrompt } from './threadLifecycle'
import { finishProjectTitle, parseTitleResult, projectTitleInstructions, readTitleProject } from './projectTitle'

const project: ProjectMeta = { projectId: 'memory', name: 'codex harness 记忆系统', shortName: null, currentSeq: 5, createdAt: 1, updatedAt: 1 }
const service = () => ({
  threadBinding: vi.fn(async (): Promise<ThreadProjectBinding | null> => ({ projectId: 'memory', phase: 'locked' })),
  get: vi.fn(async () => project),
  setShortName: vi.fn(async () => 'Harness记忆'),
})

it('excludes the long project card before truncation and preserves ordinary pasted content', () => {
  const card = insertCollapsedPaste('', 0, 0, '背景'.repeat(10_000), [], '[项目]', { kind: 'project-doc', projectId: 'memory' })
  const draft = `${card.text}\n排查 batch 报错\n`
  const paste = insertCollapsedPaste(draft, draft.length, draft.length, '错误码 503', card.pastes, '[粘贴]')
  const text = titleSourceText(paste.text, paste.pastes)
  expect(text).toBe('排查 batch 报错\n错误码 503')
  expect(threadTitlePrompt(text, project)).toContain('User: 排查 batch 报错\n错误码 503')
  expect(threadTitlePrompt(text, project)).not.toContain('背景')
  expect(threadTitlePrompt(text, project)).toContain('"shortName":null')
})

it('reads only binding and metadata and never the project document', async () => {
  const svc = service()
  expect(await readTitleProject(svc, 't')).toEqual(project)
  expect(svc.get).toHaveBeenCalledWith('memory')
  svc.threadBinding.mockResolvedValueOnce(null)
  expect(await readTitleProject(svc, 'unbound')).toBeNull()
  expect(svc.get).toHaveBeenCalledTimes(1)
})

it('uses the persisted winner rather than its own candidate in simultaneous first titles', async () => {
  const svc = service()
  const titles = await Promise.all([
    finishProjectTitle(svc, project, '{"title":"设计显式记忆","shortName":"记忆系统"}'),
    finishProjectTitle(svc, project, '{"title":"调研隐式记忆","shortName":"Harness记忆"}'),
  ])
  expect(titles).toEqual(['[Harness记忆] 设计显式记忆', '[Harness记忆] 调研隐式记忆'])
  expect(svc.setShortName).toHaveBeenCalledWith('memory', '记忆系统', true)
})

it('reuses a manual edit made during generation without overwriting it', async () => {
  const svc = service()
  svc.get.mockResolvedValue({ ...project, shortName: '个人记忆' })
  expect(await finishProjectTitle(svc, project, '{"title":"设计显式记忆","shortName":"记忆系统"}')).toBe('[个人记忆] 设计显式记忆')
  expect(svc.setShortName).not.toHaveBeenCalled()
  expect(projectTitleInstructions('Only a title', { ...project, shortName: '个人记忆' })).toContain('do not regenerate')
})

it('keeps valid titles when alias generation or persistence fails, and retries on the next title', async () => {
  const svc = service()
  for (const shortName of ['', '太'.repeat(13), 'DNS\n限速', '[DNS]']) {
    expect(await finishProjectTitle(svc, project, JSON.stringify({ title: '调研缓存', shortName }))).toBe('调研缓存')
  }
  expect(svc.setShortName).not.toHaveBeenCalled()
  svc.setShortName.mockRejectedValueOnce(new Error('write failed'))
  expect(await finishProjectTitle(svc, project, '{"title":"调研缓存","shortName":"记忆系统"}')).toBe('调研缓存')
  expect(await finishProjectTitle(svc, project, '{"title":"设计缓存","shortName":"记忆系统"}')).toBe('[Harness记忆] 设计缓存')
})

it('handles legacy plain titles, structured output and malformed responses', () => {
  expect(parseTitleResult('# 修复登录。', null).title).toBe('修复登录')
  expect(parseTitleResult('修复登录', project)).toEqual({ title: '修复登录', shortName: null })
  expect(parseTitleResult('```json\n{"title":"修复登录","shortName":"记忆"}\n```', project)).toEqual({ title: '修复登录', shortName: '记忆' })
  for (const raw of ['{"title":', 'null', '{"title":2}', '[]']) expect(parseTitleResult(raw, project).title).toBeNull()
})
