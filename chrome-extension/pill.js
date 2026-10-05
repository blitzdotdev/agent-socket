// In-page indicator for the bound tab: "AI has access to this tab · [Stop]".
// Injected by background.js into the isolated world on connect and after each
// load. Lives in a closed shadow root, re-attaches itself if the page removes
// it, and removes itself once the tab is no longer bound.

;(() => {
  if (globalThis.__asPill) return globalThis.__asPill.refresh()

  const host = document.createElement("agent-socket-indicator")
  host.style.setProperty("all", "initial", "important")
  host.style.setProperty("display", "block", "important")
  const root = host.attachShadow({ mode: "closed" })
  root.innerHTML = `<style>
    .pill { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 8px;
      padding: 6px 6px 6px 10px; border-radius: 999px; background: #16161a; color: #f2f2f5; border: 1px solid #f06;
      font: 12px/1.2 system-ui, -apple-system, sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #f06; flex: none; }
    button { font: inherit; font-weight: 600; color: #fff; background: #f06; border: 0; border-radius: 999px; padding: 4px 10px; cursor: pointer; }
  </style><div class="pill" role="status"><span class="dot"></span><span class="text">AI has access to this tab</span><button type="button">Stop</button></div>`
  const text = root.querySelector(".text")
  const stop = root.querySelector("button")

  const ago = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`)

  async function refresh() {
    let s
    try { s = await chrome.runtime.sendMessage({ type: "pill_state" }) } catch { return remove() }  // extension gone
    if (!s?.bound) return remove()
    const state = s.status === "connected" ? "AI has access to this tab"
      : s.status === "connecting" ? "AI access: connecting…" : "AI access: reconnecting…"
    text.textContent = state + (s.lastToolCallAt ? ` · last action ${ago(Date.now() - s.lastToolCallAt)} ago` : " · waiting for AI")
  }

  function remove() {
    clearInterval(timer)
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
  keep.observe(document.documentElement, { childList: true })
  const timer = setInterval(refresh, 1000)
  globalThis.__asPill = { refresh }
  refresh()
})()
