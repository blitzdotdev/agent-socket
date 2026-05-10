// Helpers for talking to the relay: HTTP fetches and raw WebSocket clients.
//
// Reads RELAY_URL env var (defaults to http://localhost:8787).

import { WebSocket } from "ws"

export const RELAY_HTTP = process.env.RELAY_URL ?? "http://localhost:8787"
export const RELAY_WS = RELAY_HTTP.replace(/^http/, "ws")

/** GET against the relay. Returns { status, body } where body is text. */
export async function httpGet(path) {
  const r = await fetch(`${RELAY_HTTP}${path}`)
  const body = await r.text()
  return { status: r.status, body, headers: r.headers }
}

/** POST JSON. body is an object (or null). Returns { status, body, json }. */
export async function httpPost(path, body) {
  const r = await fetch(`${RELAY_HTTP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body == null ? "" : JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: r.status, body: text, json }
}

/**
 * Open a raw WS to /v1/_ws. Returns an object with:
 *   send(frame)            — JSON-stringify and send
 *   waitFor(predicate, ms) — resolves with the first incoming frame
 *                            matching the predicate, rejects on timeout
 *   close()                — close the WS
 *   ws                     — the underlying ws instance
 */
export function openRawWs(opts = {}) {
  const url = `${RELAY_WS}/v1/_ws`
  const headers = opts.headers ?? {}
  const ws = new WebSocket(url, { headers })

  const inbox = []
  const waiters = []

  ws.on("message", (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { msg = { raw: data.toString() } }
    inbox.push(msg)
    // Try to satisfy waiters.
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]
      if (w.predicate(msg)) {
        waiters.splice(i, 1)
        w.resolve(msg)
        break
      }
    }
  })

  function send(frame) {
    ws.send(JSON.stringify(frame))
  }

  function waitFor(predicate, timeoutMs = 5000) {
    // Check inbox first
    for (let i = 0; i < inbox.length; i++) {
      if (predicate(inbox[i])) {
        return Promise.resolve(inbox[i])
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error(`waitFor timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const wrappedResolve = (v) => { clearTimeout(timer); resolve(v) }
      waiters.push({ predicate, resolve: wrappedResolve })
    })
  }

  function waitOpen(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ws open timeout after ${timeoutMs}ms`)), timeoutMs)
      ws.once("open", () => { clearTimeout(timer); resolve() })
      ws.once("error", (e) => { clearTimeout(timer); reject(e) })
    })
  }

  function close() {
    try { ws.close() } catch {}
  }

  return { ws, send, waitFor, waitOpen, close, inbox }
}
