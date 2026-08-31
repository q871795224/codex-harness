declare module 'postman-sandbox' {
  interface SandboxContext {
    on(event: string, handler: (...args: any[]) => void): void
    off(event: string, handler: (...args: any[]) => void): void
    dispatch(event: string, ...args: any[]): void
    execute(target: unknown, options: unknown, callback: (error: Error | null, result: any) => void): void
    dispose(callback?: () => void): void
  }
  const sandbox: {
    createContext(options: unknown, callback: (error: Error | null, context: SandboxContext) => void): void
  }
  export default sandbox
}

declare module 'postman-collection' {
  export class Event { constructor(definition: unknown) }
  export class Request {
    constructor(definition: unknown)
    method: string
    url: { addQueryParams(params: unknown): void; toString(): string }
    headers: { toJSON(): Array<{ key: string; value: string; disabled?: boolean }> }
    body?: { mode?: string; raw?: string; urlencoded?: { toJSON(): Array<{ key: string; value: string; disabled?: boolean }> } }
    toJSON(): unknown
  }
}
