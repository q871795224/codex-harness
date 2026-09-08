import { useCallback, useEffect, useState } from 'react'
import type { ProjectDocService, ThreadProjectBinding } from '../../core/project-docs/types'
import type { ProjectMeta } from './types'

/**
 * 会话 ↔ 项目绑定意图的单一事实源（方案乙，见 .harness/project-doc-plugin-plan.md）。
 *
 * - 第 0 轮：绑定面板改 / 删折叠卡都只是改 pending 意图；本 hook 提供绑定状态与操作。
 * - 第 1 轮发送成功：调用方（App）触发 `lockOnSend`，pending → locked，此后只读。
 * - 折叠卡是绑定意图在输入框里的投影，由 Composer 依据 App 传入的 spec 维护。
 */
export interface ProjectBindingState {
  /** 当前绑定（含 phase）；无绑定为 null。 */
  binding: ThreadProjectBinding | null
  /** 绑定的项目元数据；无绑定或项目列表未加载为 null。 */
  project: ProjectMeta | null
  /** 是否已锁定（locked 或旧记录）；锁定后不可改。 */
  locked: boolean
  loading: boolean
}

export function useProjectBinding(service: ProjectDocService, threadId: string | null, workspaceRoot: string | null) {
  const [binding, setBinding] = useState<ThreadProjectBinding | null>(null)
  const [project, setProject] = useState<ProjectMeta | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!threadId) {
      setBinding(null)
      setProject(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await service.threadBinding(threadId)
      setBinding(next)
      if (next) {
        const meta = await service.get(next.projectId).catch(() => null)
        setProject(meta)
        // 已绑定（含 app 重启后恢复的 locked 绑定）就确保回传服务在跑。
        await service.ensureServer().catch(() => undefined)
      } else {
        setProject(null)
      }
    } finally {
      setLoading(false)
    }
  }, [service, threadId])

  useEffect(() => {
    void reload()
  }, [reload])

  // 订阅绑定变化：面板/App 任一方操作 bind/lock/unbind 后，其它 hook 实例同步刷新。
  useEffect(() => service.subscribeBindings(() => { void reload() }), [service, reload])

  const bind = useCallback(async (projectId: string) => {
    if (!threadId) return
    await service.bindThread(threadId, projectId)
    if (workspaceRoot) await service.bindWorkspace(projectId, workspaceRoot).catch(() => undefined)
    // 绑定即确保本地回传服务在跑（Agent 才能用 project-doc 命令回传写意图）。
    await service.ensureServer().catch(() => undefined)
    await reload()
  }, [service, threadId, workspaceRoot, reload])

  const unbind = useCallback(async () => {
    if (!threadId) return
    await service.unbindThread(threadId)
    await reload()
  }, [service, threadId, reload])

  const lockOnSend = useCallback(async () => {
    if (!threadId) return
    await service.lockThreadBinding(threadId)
    await reload()
  }, [service, threadId, reload])

  const state: ProjectBindingState = {
    binding,
    project,
    locked: binding?.phase === 'locked',
    loading,
  }

  return { ...state, bind, unbind, lockOnSend, reload }
}
