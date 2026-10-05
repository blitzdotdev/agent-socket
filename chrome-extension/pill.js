// In-page indicator for the bound tab: "AI has access to this tab · 42 min left · [Stop]".
// Injected by background.js into the isolated world on connect and after each
// load. Lives in a closed shadow root, re-attaches itself if the page removes
// it, and removes itself once the tab is no longer bound. Draggable; the
// position is kept in chrome.storage.local so it stays put across loads.
// When the link changed (the old one is dead) it turns amber with
// "Link changed — paste the new link into your AI chat · [Copy link] [Stop]".
// The link is fetched from the background on the click and goes straight to
// the clipboard; it never enters the page's DOM. When the tab is on a site the
// user hasn't allowed, it says "AI paused: tab left github.com · [Allow
// mail.google.com] [Stop]".

;(() => {
  if (globalThis.__asPill) return globalThis.__asPill.refresh()

  const host = document.createElement("agent-socket-indicator")
  host.style.setProperty("all", "initial", "important")
  host.style.setProperty("display", "block", "important")
  const root = host.attachShadow({ mode: "closed" })
  root.innerHTML = `<style>
    .pill { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 8px;
      padding: 6px 6px 6px 10px; border-radius: 999px; background: #16161a; color: #f2f2f5; border: 1px solid #f06;
      font: 12px/1.2 system-ui, -apple-system, sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,.35);
      cursor: grab; user-select: none; touch-action: none; }
    .pill.dragging { cursor: grabbing; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #f06; flex: none; }
    button { font: inherit; font-weight: 600; color: #fff; background: #f06; border: 0; border-radius: 999px; padding: 4px 10px; cursor: pointer; }
    button[hidden] { display: none; }
    button:disabled { opacity: .6; cursor: default; }
    .pill.changed { border-color: #fb4; box-shadow: 0 0 0 3px rgba(255,187,68,.35), 0 2px 10px rgba(0,0,0,.35); }
    .pill.changed .dot { background: #fb4; }
    .pill.changed .text { font-weight: 600; }
    button.copy { color: #16161a; background: #fb4; }
    .left[hidden] { display: none; }
    .left.soon { color: #ff5c5c; font-weight: 700; }
    .pill.paused { border-color: #8c9cff; }
    .pill.paused .dot { background: #8c9cff; }
    button.allow { color: #16161a; background: #8c9cff; }
  </style><div class="pill" role="status"><span class="dot"></span><span class="text">AI has access to this tab</span><span class="left" hidden></span><button type="button" class="copy" data-action="copy" hidden>Copy link</button><button type="button" class="allow" data-action="allow" hidden>Allow</button><button type="button" data-action="stop">Stop</button></div>`
  const pill = root.querySelector(".pill")
  const text = root.querySelector(".text")
  const left = root.querySelector(".left")
  const copy = root.querySelector('[data-action="copy"]')
  const allow = root.querySelector('[data-action="allow"]')
  const stop = root.querySelector('[data-action="stop"]')

  // ── dragging ──
  const POS_KEY = "pill_pos"
  function place(x, y) {
    const r = pill.getBoundingClientRect()
    x = Math.min(Math.max(0, x), innerWidth - r.width)
    y = Math.min(Math.max(0, y), innerHeight - r.height)
    Object.assign(pill.style, { left: `${x}px`, top: `${y}px`, bottom: "auto" })
    return { x, y }
  }
  let drag = null
  pill.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.tagName === "BUTTON") return
    const r = pill.getBoundingClientRect()
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    pill.setPointerCapture(e.pointerId)
    pill.classList.add("dragging")
  })
  pill.addEventListener("pointermove", (e) => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy) })
  pill.addEventListener("pointerup", () => {
    if (!drag) return
    drag = null
    pill.classList.remove("dragging")
    const r = pill.getBoundingClientRect()
    chrome.storage.local.set({ [POS_KEY]: { x: r.left / innerWidth, y: r.top / innerHeight } }).catch(() => {})
  })
  function restore() {
    chrome.storage.local.get(POS_KEY).then((v) => {
      const p = v[POS_KEY]
      if (p) place(p.x * innerWidth, p.y * innerHeight)
    }).catch(() => {})
  }
  addEventListener("resize", restore)

  const ago = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`)

  let note = null  // { text, until }: a short message after Copy, over the usual text

  async function refresh() {
    let s
    try { s = await chrome.runtime.sendMessage({ type: "pill_state" }) } catch { return remove() }  // extension gone
    if (!s?.bound) return remove()
    const paused = !s.linkChanged && s.paused
    pill.classList.toggle("changed", !!s.linkChanged)
    pill.classList.toggle("paused", !!paused)
    copy.hidden = !s.linkChanged
    allow.hidden = !paused?.origin
    if (paused?.origin) { allow.textContent = `Allow ${paused.host}`; allow.dataset.origin = paused.origin }
    left.hidden = !s.left || !!s.linkChanged || !!paused
    left.textContent = s.left ? `· ${s.left}` : ""
    left.classList.toggle("soon", !!s.soon)
    if (note && Date.now() < note.until) { text.textContent = note.text; return }
    note = null
    if (s.linkChanged) { text.textContent = "Link changed — paste the new link into your AI chat"; return }
    if (paused) { text.textContent = paused.from ? `AI paused: tab left ${paused.from}` : "AI paused: no site allowed"; return }
    const state = s.status === "connected" ? "AI has access to this tab"
      : s.status === "connecting" ? "AI access: connecting…" : "AI access: reconnecting…"
    text.textContent = state + (s.lastToolCallAt ? ` · last action ${ago(Date.now() - s.lastToolCallAt)} ago` : " · waiting for AI")
  }

  // Allow counts only for a real click on a button the page isn't covering
  // (IntersectionObserver v2 visibility), so a page can't trick the user into it.
  let allowVisible = false
  const seen = new IntersectionObserver((es) => { allowVisible = es.at(-1).isVisible }, { trackVisibility: true, delay: 100 })
  seen.observe(allow)
  allow.addEventListener("click", async (e) => {
    if (!e.isTrusted) return
    if (!allowVisible) {
      note = { text: "Allow it from the Agent Socket toolbar icon", until: Date.now() + 6000 }
      return void refresh()
    }
    allow.disabled = true
    try {
      const r = await chrome.runtime.sendMessage({ type: "allow_origin", origin: allow.dataset.origin }).catch(() => null)
      if (r?.ok) note = { text: "Allowed for this session", until: Date.now() + 3000 }
    } finally {
      allow.disabled = false
      void refresh()
    }
  })

  // navigator.clipboard needs a secure context. On http:// pages fall back to
  // the copy command on a field in our closed shadow root, setting the data
  // in our own copy listener so a page listener can't swap it; if the page
  // stops the event before it reaches us, report failure.
  async function writeClipboard(value) {
    try { await navigator.clipboard.writeText(value); return true } catch {}
    const field = document.createElement("textarea")
    field.value = value
    field.readOnly = true
    field.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;"
    let wrote = false
    field.addEventListener("copy", (e) => {
      e.clipboardData.setData("text/plain", value)
      e.preventDefault()
      e.stopImmediatePropagation()
      wrote = true
    })
    root.append(field)
    field.select()
    let ok = false
    try { ok = document.execCommand("copy") } catch {}
    field.remove()
    return ok && wrote
  }

  copy.addEventListener("click", async (e) => {
    if (!e.isTrusted) return
    copy.disabled = true
    try {
      const r = await chrome.runtime.sendMessage({ type: "pill_link" }).catch(() => null)
      if (r?.url && await writeClipboard(r.url)) {
        await chrome.runtime.sendMessage({ type: "ack_link", via: "pill" }).catch(() => {})
        note = { text: "New link copied — paste it into your AI chat", until: Date.now() + 3000 }
      } else {
        // No clipboard here: the popup has the link and its own Copy.
        const o = await chrome.runtime.sendMessage({ type: "open_popup" }).catch(() => null)
        note = { text: o?.ok ? "Copy the new link in the Agent Socket popup" : "Click the Agent Socket toolbar icon to copy the new link", until: Date.now() + 6000 }
      }
    } finally {
      copy.disabled = false
      void refresh()
    }
  })

  function remove() {
    clearInterval(timer)
    seen.disconnect()
    removeEventListener("resize", restore)
    keep.disconnect()
    chrome.runtime.onMessage.removeListener(onMessage)
    host.remove()
    delete globalThis.__asPill
  }

  const onMessage = (m) => { if (m?.type === "as_pill_remove") remove() }
  stop.addEventListener("click", (e) => {
    if (!e.isTrusted) return
    stop.disabled = true
    chrome.runtime.sendMessage({ type: "disconnect" }).catch(() => {})
    remove()
  })

  const keep = new MutationObserver(() => { if (!host.isConnected) document.documentElement.appendChild(host) })
  chrome.runtime.onMessage.addListener(onMessage)
  document.documentElement.appendChild(host)
  restore()
  keep.observe(document.documentElement, { childList: true })
  const timer = setInterval(refresh, 1000)
  globalThis.__asPill = { refresh }
  refresh()
})()
