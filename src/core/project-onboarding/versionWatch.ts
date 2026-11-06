import type { ProjectDocService } from '../project-docs/types'

/** Poll only project metadata; never reread the document while generating. */
export function watchProjectVersion(docs: ProjectDocService, projectId: string, baseSeq: number) {
  const controller = new AbortController()
  let stopped = false
  let pending: Promise<void> | undefined
  const check = async (): Promise<void> => {
    controller.signal.throwIfAborted()
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      try {
        const current = await docs.get(projectId)
        if (!stopped && current.currentSeq !== baseSeq) {
          controller.abort(new Error(`项目文档已有新版本（v${baseSeq} → v${current.currentSeq}），已停止本次整理，未保存结果。请重新整理。`))
        }
      } catch (error) {
        if (!stopped) controller.abort(new Error(`无法检查项目版本，已停止本次整理，未保存结果：${error instanceof Error ? error.message : String(error)}`))
      }
      controller.signal.throwIfAborted()
    })().finally(() => { pending = undefined })
    return pending
  }
  const timer = setInterval(() => { void check().catch(() => {}) }, 1_000)
  return {
    signal: controller.signal,
    check,
    stop: () => { stopped = true; clearInterval(timer) },
  }
}

/** Ignore late results while still allowing the caller to cancel a late-started run. */
export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
