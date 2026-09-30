import type { JsonObject } from '../domain/codex'

const KEY_PREFIX = 'threadPermissions.v1:'

export class ThreadPermissionsSaveError extends Error {
  constructor(cause: unknown) {
    super(`会话操作已生效，但无法保存权限设置，下次恢复可能使用默认权限：${String(cause)}`)
  }
}

interface PermissionRuntime {
  request(method: string, params: JsonObject): Promise<unknown>
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
}

// Store only explicit Harness choices, never prompts or inferred global defaults.
// Serializing each thread keeps a resume from racing a successful settings write.
export function createThreadPermissionRequest(runtime: PermissionRuntime) {
  const pending = new Map<string, Promise<unknown>>()

  async function run(method: string, params: JsonObject): Promise<unknown> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    const managed = method === 'thread/resume' || method === 'thread/settings/update' || method === 'thread/delete'
    const patch = permissionPatch(params)
    let saved: JsonObject = {}
    if (threadId && managed && method !== 'thread/delete') {
      const raw = await runtime.read(KEY_PREFIX + threadId)
      if (raw) {
        try { saved = permissionPatch(JSON.parse(raw)) }
        catch { /* Invalid local preferences must never enable permissions. */ }
      }
    }
    const requestParams = method === 'thread/resume' && !params.history && !params.path && params.permissions == null
      ? { ...saved, ...params }
      : params
    const result = await runtime.request(method, requestParams)

    let saveId = threadId
    let next: JsonObject | null = null
    if (method === 'thread/start' && params.ephemeral !== true && Object.keys(patch).length) {
      const response = result as { thread: { id: string; ephemeral?: boolean } }
      if (!response.thread.ephemeral) {
        saveId = response.thread.id
        next = patch
      }
    } else if (threadId && managed) {
      if (method === 'thread/delete') next = {}
      else if (Object.keys(patch).length || params.sandboxPolicy != null || params.permissions != null) {
        next = params.permissions != null ? { ...patch } : { ...saved, ...patch }
        // Never replay an old full-access mode over a named/external/custom policy.
        if (params.permissions != null || (params.sandboxPolicy != null && patch.sandbox === undefined)) delete next.sandbox
      }
    }
    if (saveId && next) {
      try { await runtime.write(KEY_PREFIX + saveId, JSON.stringify(next)) }
      catch (error) { throw new ThreadPermissionsSaveError(error) }
    }
    return result
  }

  return async function request<T>(method: string, params: JsonObject): Promise<T> {
    if (!['thread/start', 'thread/resume', 'thread/settings/update', 'thread/delete'].includes(method)) {
      return runtime.request(method, params) as Promise<T>
    }
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    if (!threadId) return run(method, params) as Promise<T>
    const operation = (pending.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(() => run(method, params))
    pending.set(threadId, operation)
    try { return await operation as T }
    finally { if (pending.get(threadId) === operation) pending.delete(threadId) }
  }
}

function permissionPatch(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const params = value as JsonObject
  const patch: JsonObject = {}
  if (params.approvalPolicy === 'never' || params.approvalPolicy === 'on-request' || params.approvalPolicy === 'untrusted') patch.approvalPolicy = params.approvalPolicy
  if (params.approvalsReviewer === 'user' || params.approvalsReviewer === 'auto_review') patch.approvalsReviewer = params.approvalsReviewer
  if (params.sandbox === 'danger-full-access' || params.sandbox === 'workspace-write' || params.sandbox === 'read-only') patch.sandbox = params.sandbox
  const policy = params.sandboxPolicy as JsonObject | undefined
  if (policy?.type === 'dangerFullAccess') patch.sandbox = 'danger-full-access'
  // These are the standard policies emitted by the Harness permission controls.
  // Custom roots/network policies cannot be represented by a resume sandbox mode.
  if (policy?.type === 'readOnly' && policy.networkAccess === false) patch.sandbox = 'read-only'
  if (policy?.type === 'workspaceWrite' && Array.isArray(policy.writableRoots) && policy.writableRoots.length === 0
    && policy.networkAccess === false && policy.excludeTmpdirEnvVar === false && policy.excludeSlashTmp === false) patch.sandbox = 'workspace-write'
  return patch
}
