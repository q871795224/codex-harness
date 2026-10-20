import { useEffect, useRef } from 'react'
import { runtime } from '../runtime/bridge'
import { createManagementHandler, type ManagementContext } from './service'

export function useManagement(context: ManagementContext) {
  const current = useRef(context)
  current.current = context
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    let queue = Promise.resolve()
    const handle = createManagementHandler(() => current.current)
    void runtime.listenManagementRequests((request) => {
      const receivedAt = Date.now()
      queue = queue.then(async () => {
        if (disposed) return
        try {
          if (Date.now() - receivedAt > 55_000) throw new Error('管理请求排队超时，未执行')
          await runtime.managementRespond(request.requestId, await handle(request))
        } catch (error) {
          await runtime.managementRespond(request.requestId, undefined, error instanceof Error ? error.message : String(error))
        }
      }).catch((error) => current.current.harness.notify('管理请求回传失败', 'error', error))
    }).then(async (stop) => {
      if (disposed) { stop(); return }
      unlisten = stop
      await runtime.managementReady(true)
    }).catch((error) => current.current.harness.notify('管理入口启动失败', 'error', error))
    return () => {
      disposed = true
      unlisten?.()
      void runtime.managementReady(false).catch(() => undefined)
    }
  }, [])
}
