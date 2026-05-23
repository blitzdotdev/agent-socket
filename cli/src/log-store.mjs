// Pure in-memory chat log with bounded retention, per-name awaiters,
// and last-activity tracking. No I/O — host module wires fs + WS around it.

const MAX_ENTRIES   = 1000
const MAX_MSG_BYTES = 64 * 1024
const SCROLLBACK    = 50
const RECV_BATCH    = 200
const PEER_TTL_MS   = 5 * 60 * 1000   // who's considered "around" for /peers

export class LogStore {
  constructor() {
    this.log = []                  // ring; oldest evicted on overflow
    this.nextSeq = 1
    this.firstRetainedSeq = 1
    this.lastActive = new Map()    // name → ts
    this.waiters = new Map()       // name → ResolverList; null key = lurkers
    this.waiters.set(null, [])
  }

  /** Append a message. Returns the appended record (with assigned seq + ts). */
  append({ from, text }) {
    if (typeof text !== "string") throw bad("text must be a string")
    if (Buffer.byteLength(text, "utf8") > MAX_MSG_BYTES) throw bad("message_too_large", `text > ${MAX_MSG_BYTES} bytes`)
    const seq = this.nextSeq++
    const ts = Date.now()
    const msg = { seq, from, text, ts }
    this.log.push(msg)
    while (this.log.length > MAX_ENTRIES) {
      this.log.shift()
      this.firstRetainedSeq = this.log[0]?.seq ?? this.nextSeq
    }
    if (from) this.touch(from)
    this.wakeWaiters(msg)
    return msg
  }

  touch(name) {
    this.lastActive.set(name, Date.now())
  }

  /** Resolve any open waiters with the new message (with awaiting flag). */
  wakeWaiters(msg) {
    // The sender's `awaiting` flag depends on whether THEY have an open
    // recv waiter at THIS moment (i.e. they did /recv with a message and
    // are now blocked waiting for the next message themselves).
    const payload = { ...msg, awaiting: this.hasOpenWaiter(msg.from) }

    // Named waiters — skip the sender's own list (don't echo own message)
    for (const [name, list] of this.waiters) {
      if (name === null) continue
      if (name === msg.from) continue
      if (list.length === 0) continue
      const drained = list.splice(0)
      for (const r of drained) r.resolve([payload])
    }
    // Lurkers (no name) — get every message
    const lurkers = this.waiters.get(null)
    if (lurkers && lurkers.length) {
      const drained = lurkers.splice(0)
      for (const r of drained) r.resolve([payload])
    }
  }

  hasOpenWaiter(name) {
    if (!name) return false
    const l = this.waiters.get(name)
    return !!l && l.length > 0
  }

  /** First-time scrollback. Returns last N messages (regardless of seq). */
  scrollback(senderName) {
    const tail = this.log.slice(-SCROLLBACK)
    const messages = tail
      .filter((m) => m.from !== senderName)        // don't echo own messages
      .map((m) => ({ ...m, awaiting: this.hasOpenWaiter(m.from) }))
    return { messages, latest_seq: this.nextSeq - 1 }
  }

  /** Resumed recv. Returns up to RECV_BATCH messages with seq > since. */
  drain({ since, senderName }) {
    const result = []
    let missed = 0
    if (since < this.firstRetainedSeq - 1) {
      missed = (this.firstRetainedSeq - 1) - since
    }
    for (const m of this.log) {
      if (m.seq <= since) continue
      if (m.from === senderName) continue       // skip own messages
      result.push({ ...m, awaiting: this.hasOpenWaiter(m.from) })
      if (result.length >= RECV_BATCH) break
    }
    return {
      messages: result,
      latest_seq: this.nextSeq - 1,
      ...(missed > 0 ? { missed_messages: missed } : {}),
    }
  }

  /**
   * Register a long-poll waiter. Returns { promise, cancel }.
   *
   * The waiter is added to the waiters map BEFORE this returns, so
   * hasOpenWaiter(name) reflects it immediately. That's important for
   * the awaiting flag on send-and-wait: the sender's recv reserves a
   * waiter, THEN broadcasts the message, so recipients see awaiting:true.
   *
   * Call cancel() to remove the waiter without resolving (e.g., when
   * recv decides to drain-and-return instead of blocking).
   */
  wait({ name, maxMs }) {
    const key = name ?? null
    if (!this.waiters.has(key)) this.waiters.set(key, [])
    const list = this.waiters.get(key)
    if (name) this.touch(name)

    let externResolve
    const promise = new Promise((r) => { externResolve = r })
    const entry = { cancelled: false, timer: null, resolve: null }
    const finish = (value) => {
      if (entry.cancelled) return
      entry.cancelled = true
      if (entry.timer) clearTimeout(entry.timer)
      const i = list.indexOf(entry)
      if (i !== -1) list.splice(i, 1)
      externResolve(value)
    }
    entry.resolve = finish
    entry.timer = setTimeout(() => finish([]), maxMs)
    list.push(entry)

    return {
      promise,
      cancel: () => {
        if (entry.cancelled) return
        entry.cancelled = true
        if (entry.timer) clearTimeout(entry.timer)
        const i = list.indexOf(entry)
        if (i !== -1) list.splice(i, 1)
        externResolve([])  // unblock anyone awaiting the promise
      },
    }
  }

  /** True iff any named or lurker waiter is currently open. */
  hasAnyWaiter() {
    for (const list of this.waiters.values()) if (list.length > 0) return true
    return false
  }

  /** Timestamp (ms) of the most recent message, or 0 if log is empty. */
  latestMessageTs() {
    if (this.log.length === 0) return 0
    return this.log[this.log.length - 1].ts
  }

  /** Snapshot of who's around — for /peers. */
  peers() {
    const now = Date.now()
    const out = []
    for (const [name, ts] of this.lastActive) {
      const ago = now - ts
      if (ago > PEER_TTL_MS) continue
      out.push({
        name,
        last_active_s_ago: Math.round(ago / 1000),
        currently_waiting: this.hasOpenWaiter(name),
      })
    }
    out.sort((a, b) => a.last_active_s_ago - b.last_active_s_ago)
    return { peers: out }
  }
}

function bad(code, message) {
  const e = new Error(message ?? code)
  e.code = code
  e.statusHint = 400
  return e
}
