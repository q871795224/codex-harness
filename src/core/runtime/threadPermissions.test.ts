import { describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../domain/codex'
import { createThreadPermissionRequest, ThreadPermissionsSaveError } from './threadPermissions'

const yolo = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
const workspacePolicy = {
  type: 'workspaceWrite', writableRoots: [], networkAccess: false,
  excludeTmpdirEnvVar: false, excludeSlashTmp: false,
}

function fixture() {
  const database = new Map<string, string>()
  const native = {
    request: vi.fn(async (_method: string, _params: JsonObject): Promise<unknown> => ({ thread: { id: 'a' } })),
    read: vi.fn(async (key: string) => database.get(key) ?? null),
    write: vi.fn(async (key: string, value: string) => { database.set(key, value) }),
  }
  return { database, native, request: createThreadPermissionRequest(native) }
}

describe('persisted thread permissions', () => {
  it('restores a new YOLO thread after recreating the client, without changing resume pagination or cwd', async () => {
    const { native, request, database } = fixture()
    await request('thread/start', { ...yolo, cwd: '/project', developerInstructions: 'private instructions' })
    expect([...database.values()]).toEqual([JSON.stringify(yolo)])

    const restarted = createThreadPermissionRequest(native)
    const params = { threadId: 'a', cwd: '/project', runtimeWorkspaceRoots: ['/project'], excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: 'summary' } }
    await restarted('thread/resume', params)
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { ...params, ...yolo })
    await restarted('thread/resume', { threadId: 'b' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'b' })
  })

  it('remembers switching YOLO off, including across another client restart', async () => {
    const { native, request } = fixture()
    await request('thread/start', yolo)
    await request('thread/settings/update', {
      threadId: 'a', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: workspacePolicy,
    })
    await createThreadPermissionRequest(native)('thread/resume', { threadId: 'a' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', {
      threadId: 'a', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
    })
  })

  it('remembers read-only and auto-review choices and merges partial setting updates', async () => {
    const { native, request } = fixture()
    await request('thread/settings/update', { threadId: 'a', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    await request('thread/settings/update', { threadId: 'a', approvalsReviewer: 'auto_review' })
    await request('thread/settings/update', { threadId: 'a', model: 'another-model', effort: 'high' })
    await createThreadPermissionRequest(native)('thread/resume', { threadId: 'a' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', {
      threadId: 'a', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'read-only',
    })
  })

  it('never records a rejected permission change', async () => {
    const { native, request } = fixture()
    await request('thread/settings/update', { threadId: 'a', approvalPolicy: 'on-request', sandboxPolicy: workspacePolicy })
    native.request.mockRejectedValueOnce(new Error('rejected'))
    await expect(request('thread/settings/update', { threadId: 'a', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })).rejects.toThrow('rejected')
    await request('thread/resume', { threadId: 'a' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'a', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  })

  it('keeps explicit resume overrides ahead of remembered choices', async () => {
    const { native, request } = fixture()
    await request('thread/start', yolo)
    await request('thread/resume', { threadId: 'a', approvalPolicy: 'untrusted', sandbox: 'read-only' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', {
      threadId: 'a', approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only',
    })
  })

  it('does not persist ephemeral generator permissions or infer defaults for old threads', async () => {
    const { native, request, database } = fixture()
    await request('thread/start', { ...yolo, ephemeral: true })
    await request('thread/start', { cwd: '/project' })
    await request('thread/resume', { threadId: 'old' })
    expect(database.size).toBe(0)
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'old' })
  })

  it.each(['broken', 'null', '[]', '{"sandbox":"invalid","approvalPolicy":"invalid"}'])(
    'ignores malformed stored choices: %s', async (raw) => {
      const { native, request, database } = fixture()
      database.set('threadPermissions.v1:a', raw)
      await request('thread/resume', { threadId: 'a' })
      expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'a' })
    },
  )

  it('waits for permission persistence before a concurrent resume', async () => {
    const { native, request } = fixture()
    let finish!: () => void
    native.request.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({}) }))
    const update = request('thread/settings/update', { threadId: 'a', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
    await vi.waitFor(() => expect(finish).toBeDefined())
    const resume = request('thread/resume', { threadId: 'a' })
    expect(native.request).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([update, resume])
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'a', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  })

  it('clears permissions after successful thread deletion', async () => {
    const { native, request } = fixture()
    await request('thread/start', yolo)
    await request('thread/delete', { threadId: 'a' })
    await request('thread/resume', { threadId: 'a' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'a' })
  })

  it('does not reuse a thread id preference when resuming a different history or path', async () => {
    const { native, request } = fixture()
    await request('thread/start', yolo)
    const params = { threadId: 'a', path: '/other/rollout.jsonl' }
    await request('thread/resume', params)
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', params)
  })

  it('drops stale full access when a custom sandbox is selected', async () => {
    const { native, request } = fixture()
    await request('thread/start', yolo)
    await request('thread/settings/update', { threadId: 'a', sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } })
    await request('thread/resume', { threadId: 'a' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'a', approvalPolicy: 'never', approvalsReviewer: 'user' })
  })

  it('does not combine remembered legacy permissions with a named profile', async () => {
    const { native, request } = fixture()
    await request('thread/start', yolo)
    await request('thread/resume', { threadId: 'a', permissions: 'managed-profile' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'a', permissions: 'managed-profile' })
    await request('thread/resume', { threadId: 'a' })
    expect(native.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'a' })
  })

  it('distinguishes persistence failure after an applied setting from a rejected setting', async () => {
    const { native, request } = fixture()
    native.write.mockRejectedValueOnce(new Error('disk full'))
    await expect(request('thread/settings/update', { threadId: 'a', sandboxPolicy: { type: 'dangerFullAccess' } })).rejects.toBeInstanceOf(ThreadPermissionsSaveError)
    expect(native.request).toHaveBeenCalledWith('thread/settings/update', { threadId: 'a', sandboxPolicy: { type: 'dangerFullAccess' } })
  })
})
