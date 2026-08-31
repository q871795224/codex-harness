import { describe, expect, it, vi } from 'vitest'
import { subscribeHarnessRuntime, type HarnessSubscriptionRuntime } from './harnessSubscriptions'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Harness runtime subscriptions', () => {
  it('unsubscribes listeners that resolve before disposal', async () => {
    const eventUnlisten = vi.fn()
    const transportUnlisten = vi.fn()
    const runtime: HarnessSubscriptionRuntime = {
      listenEvents: vi.fn().mockResolvedValue(eventUnlisten),
      listenTransport: vi.fn().mockResolvedValue(transportUnlisten),
    }

    const dispose = subscribeHarnessRuntime(runtime, vi.fn(), vi.fn(), vi.fn())
    await Promise.resolve()
    dispose()
    dispose()

    expect(eventUnlisten).toHaveBeenCalledTimes(1)
    expect(transportUnlisten).toHaveBeenCalledTimes(1)
  })

  it('immediately unsubscribes a listener that resolves after disposal', async () => {
    const pendingEvent = deferred<() => void>()
    const pendingTransport = deferred<() => void>()
    const eventUnlisten = vi.fn()
    const transportUnlisten = vi.fn()
    const runtime: HarnessSubscriptionRuntime = {
      listenEvents: vi.fn(() => pendingEvent.promise),
      listenTransport: vi.fn(() => pendingTransport.promise),
    }

    const dispose = subscribeHarnessRuntime(runtime, vi.fn(), vi.fn(), vi.fn())
    dispose()
    pendingEvent.resolve(eventUnlisten)
    pendingTransport.resolve(transportUnlisten)
    await Promise.all([pendingEvent.promise, pendingTransport.promise])
    await Promise.resolve()

    expect(eventUnlisten).toHaveBeenCalledTimes(1)
    expect(transportUnlisten).toHaveBeenCalledTimes(1)
  })

  it('reports subscription failures only while active', async () => {
    const pendingEvent = deferred<() => void>()
    const pendingTransport = deferred<() => void>()
    const onError = vi.fn()
    const runtime: HarnessSubscriptionRuntime = {
      listenEvents: vi.fn(() => pendingEvent.promise),
      listenTransport: vi.fn(() => pendingTransport.promise),
    }

    const dispose = subscribeHarnessRuntime(runtime, vi.fn(), vi.fn(), onError)
    pendingEvent.reject(new Error('event listener failed'))
    await pendingEvent.promise.catch(() => undefined)
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)

    dispose()
    pendingTransport.reject(new Error('late failure'))
    await pendingTransport.promise.catch(() => undefined)
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
