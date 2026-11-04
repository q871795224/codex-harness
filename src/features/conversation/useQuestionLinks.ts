import { useEffect, useRef, useState } from 'react'
import { runtime } from '../../core/runtime/bridge'
import { parseQuestionLink } from '../../core/questions/links'
import type { QuestionNavigation } from '../../core/questions/types'
import { notifications } from '../../core/notifications/service'

export function useQuestionLinks(ready: boolean, openThread: (threadId: string) => Promise<void>, revealConversation: () => void) {
  const [navigation, setNavigation] = useState<QuestionNavigation | null>(null)
  const callbacks = useRef({ openThread, revealConversation })
  callbacks.current = { openThread, revealConversation }
  const sequence = useRef(0)
  useEffect(() => {
    if (!ready) return
    let disposed = false
    let unlisten: (() => void) | undefined
    let tasks = Promise.resolve()
    const drain = () => {
      tasks = tasks.then(async () => {
        if (disposed) return
        for (const value of await runtime.drainQuestionLinks()) {
          if (disposed) return
          try {
            const locator = parseQuestionLink(value)
            callbacks.current.revealConversation()
            await callbacks.current.openThread(locator.thread)
            if (!disposed) setNavigation({ locator, sequence: ++sequence.current })
          } catch {
            notifications.publish({ level: 'warning', source: 'question-links', title: '无法打开问题', message: '问题链接无效或会话当前不可用，请在 Harness 内查看。' })
          }
        }
      }).catch(() => undefined)
    }
    // Subscribe first, then drain: links arriving during WebView startup cannot be lost.
    void runtime.listenQuestionLinks(drain).then((dispose) => {
      if (disposed) { dispose(); return }
      unlisten = dispose; drain()
    }).catch(() => undefined)
    return () => { disposed = true; unlisten?.() }
  }, [ready])
  return navigation
}
