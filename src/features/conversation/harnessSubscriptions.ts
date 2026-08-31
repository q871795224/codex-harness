import type { AppServerEvent, JsonObject } from '../../core/domain/codex'

type Unlisten = () => void

export interface HarnessSubscriptionRuntime {
  listenEvents(handler: (event: AppServerEvent) => void): Promise<Unlisten>
  listenTransport(handler: (event: JsonObject) => void): Promise<Unlisten>
}

export function subscribeHarnessRuntime(
  runtime: HarnessSubscriptionRuntime,
  onEvent: (event: AppServerEvent) => void,
  onTransport: (event: JsonObject) => void,
  onError: (error: unknown) => void,
): Unlisten {
  let disposed = false
  const unlisteners: Unlisten[] = []

  const attach = (subscription: Promise<Unlisten>) => {
    void subscription.then((unlisten) => {
      if (disposed) unlisten()
      else unlisteners.push(unlisten)
    }).catch((error) => {
      if (!disposed) onError(error)
    })
  }

  attach(runtime.listenEvents(onEvent))
  attach(runtime.listenTransport(onTransport))

  return () => {
    if (disposed) return
    disposed = true
    for (const unlisten of unlisteners.splice(0)) unlisten()
  }
}
