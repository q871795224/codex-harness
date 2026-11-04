export interface DraftAnswer { value: string; other: boolean }
export type QuestionAnswers = Record<string, DraftAnswer>
interface Storage { load(key: string): Promise<string | null>; save(key: string, value: string): Promise<void> }
const EMPTY: QuestionAnswers = {}

/** Stores only unsent answers. Question text and sensitive answers never enter storage. */
export function createQuestionDrafts(storage: Storage) {
  const answers = new Map<string, QuestionAnswers>()
  const loads = new Map<string, Promise<void>>()
  const writes = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  const persist = (key: string, secrets: Set<string>) => {
    const value = JSON.stringify(Object.fromEntries(Object.entries(answers.get(key) ?? EMPTY).filter(([id]) => !secrets.has(id))))
    const next = (writes.get(key) ?? Promise.resolve()).then(() => storage.save(key, value)).catch(() => undefined)
    writes.set(key, next)
    return next
  }
  return {
    snapshot: (key: string) => answers.get(key) ?? EMPTY,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load(key: string, secrets: Set<string>): Promise<void> {
      if (!loads.has(key)) loads.set(key, (async () => {
        try {
          const raw = await storage.load(key)
          const parsed: unknown = raw ? JSON.parse(raw) : {}
          const restored: QuestionAnswers = {}
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const [id, answer] of Object.entries(parsed)) {
            if (!secrets.has(id) && answer && typeof answer.value === 'string' && typeof answer.other === 'boolean') restored[id] = { value: answer.value, other: answer.other }
          }
          answers.set(key, { ...restored, ...answers.get(key) })
        } catch { /* Storage failure must not block the existing answer form. */ }
        emit()
      })())
      return loads.get(key)!
    },
    update(key: string, id: string, answer: DraftAnswer, secrets: Set<string>) {
      answers.set(key, { ...answers.get(key), [id]: answer }); emit(); void persist(key, secrets)
    },
    append(key: string, id: string, value: string, secrets: Set<string>) {
      const previous = answers.get(key)?.[id]
      const answer = previous?.value ? { value: `${previous.value}\n${value}`, other: true } : { value, other: false }
      answers.set(key, { ...answers.get(key), [id]: answer }); emit(); return persist(key, secrets)
    },
    clear(key: string) { answers.set(key, EMPTY); emit(); return persist(key, new Set()) },
  }
}
