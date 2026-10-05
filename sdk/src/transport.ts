// WebSocket transport over the runtime's native WebSocket (browsers, Workers,
// Node 22+). Wraps it in a minimal send/close/addListener surface.

export interface MinWS {
  send(data: string): void
  close(code?: number, reason?: string): void
  /** "open" | "message" | "close" | "error" */
  addListener(event: string, fn: (...args: unknown[]) => void): void
  removeListener(event: string, fn: (...args: unknown[]) => void): void
  readonly readyState: number
}

const READY_OPEN = 1

export function openWs(url: string): MinWS {
  const Native = (globalThis as any).WebSocket as typeof WebSocket | undefined
  if (!Native) throw new Error("No global WebSocket — agent-socket needs a browser, Workers, or Node 22+.")
  return wrapNative(new Native(url))
}

function wrapNative(ws: WebSocket): MinWS {
  // Map our addListener/removeListener naming to addEventListener/removeEventListener
  // and adapt event objects to the listener signatures the SDK expects.
  const adapters = new WeakMap<(...args: unknown[]) => void, EventListener>()
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    get readyState() { return ws.readyState },
    addListener: (event, fn) => {
      let adapter: EventListener
      switch (event) {
        case "message":
          adapter = (ev) => fn((ev as MessageEvent).data as string)
          break
        case "close":
          adapter = (ev) => {
            const ce = ev as CloseEvent
            fn(ce.code, ce.reason)
          }
          break
        case "error":
          adapter = (ev) => fn(ev)
          break
        case "open":
        default:
          adapter = () => fn()
          break
      }
      adapters.set(fn, adapter)
      ws.addEventListener(event, adapter)
    },
    removeListener: (event, fn) => {
      const adapter = adapters.get(fn)
      if (adapter) ws.removeEventListener(event, adapter)
    },
  }
}

export const READY_STATE_OPEN = READY_OPEN
