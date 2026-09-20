// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { appServer } from '../../core/runtime/appServerClient'
import { useSkillCatalog } from './SkillCatalog'

vi.mock('../../core/runtime/appServerClient', () => ({ appServer: { listSkills: vi.fn() } }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('loads only after a skill read is present and does not refetch on output updates', async () => {
  vi.mocked(appServer.listSkills).mockResolvedValue({ data: [{ skills: [] }] })
  const { rerender } = renderHook(({ enabled }) => useSkillCatalog('/repo', enabled), { initialProps: { enabled: false } })
  expect(appServer.listSkills).not.toHaveBeenCalled()
  await act(async () => { rerender({ enabled: true }) })
  rerender({ enabled: true })
  expect(appServer.listSkills).toHaveBeenCalledTimes(1)
})

it('ignores a late response from the previous workspace and tolerates catalog failure', async () => {
  let resolve!: (response: Awaited<ReturnType<typeof appServer.listSkills>>) => void
  vi.mocked(appServer.listSkills).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    .mockRejectedValueOnce(new Error('offline'))
  const { result, rerender } = renderHook(({ cwd }) => useSkillCatalog(cwd, true), { initialProps: { cwd: '/old' } })
  await act(async () => { rerender({ cwd: '/new' }) })
  await act(async () => { resolve({ data: [{ skills: [{ name: 'old', path: '/old/SKILL.md', description: '', enabled: true, scope: 'user', pluginId: null }] }] }) })
  await waitFor(() => expect(result.current).toEqual([]))
  expect(appServer.listSkills).toHaveBeenLastCalledWith('/new')
})
