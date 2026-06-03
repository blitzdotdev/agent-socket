// Background service worker.
//
// Owns the WebSocket connection to the agent-socket relay. Builds the tool
// list from base tools + the active tab's site profile (if any). Dispatches
// tool_call frames to handlers that run chrome.scripting.executeScript in the
// page's MAIN world.

import { ASClient } from "./lib/as-client.js"
import { buildBaseTools, buildSiteTools } from "./lib/tools-base.js"

// ── state ──────────────────────────────────────────────────────────
let client = null
let lastStatus = { status: "idle" }
let lastUrl = null
let lastToken = null
let lastProfile = null     // site profile loaded for the currently-bound tab
let boundTabId = null      // the tab we last connected for (so we know which one to "drive")

// Recent console messages per tab, kept in-memory.
const consoleByTab = new Map()  // tabId → [{ level, text, ts }]
const MAX_CONSOLE_PER_TAB = 200

// Default relay base. Overridable in the popup via chrome.storage.local.relay_base.
const DEFAULT_BASE = "https://agentsocket.dev"

// ── helpers ────────────────────────────────────────────────────────

async function getActiveTabId() {
  // If we have a bound tab and it's still alive, use it. Otherwise fall back
  // to the current active tab. This keeps long-running agent sessions stable
  // even if the user clicks around.
  if (boundTabId != null) {
    try {
      const t = await chrome.tabs.get(boundTabId)
      if (t) return t.id
    } catch { /* tab gone */ }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null
}

function getRecentConsole(tabId, limit) {
  return (consoleByTab.get(tabId) ?? []).slice(-limit)
}

async function loadSiteProfileForUrl(url) {
  if (!url) return null
  let host
  try { host = new URL(url).host } catch { return null }
  // Check user-saved profiles first.
  const stored = (await chrome.storage.local.get("site_profiles")).site_profiles ?? {}
  if (stored[host]) return stored[host]
  // Fall back to bundled tools-lib.
  try {
    const idxRes = await fetch(chrome.runtime.getURL("tools-lib/_index.json"))
    const idx = await idxRes.json()
    for (const p of idx.profiles ?? []) {
      if (p.host_match === host || (p.host_match.startsWith("*.") && host.endsWith(p.host_match.slice(1)))) {
        const r = await fetch(chrome.runtime.getURL(`tools-lib/${p.file}`))
        return await r.json()
      }
    }
    // No specific match: use generic if present.
    const gen = idx.profiles?.find((p) => p.host_match === "*")
    if (gen) {
      const r = await fetch(chrome.runtime.getURL(`tools-lib/${gen.file}`))
      return await r.json()
    }
  } catch (e) { console.warn("[as-ext] profile load failed:", e) }
  return null
}

function buildAgentsMd({ host, profile, tools }) {
  const tooLines = tools.map((t) => `- \`${(t.method ?? "POST")} ${t.path}\` — ${t.description.split("\n")[0]}`).join("\n")
  return [
    `# Agent Socket — driving \`${host || "the active browser tab"}\``,
    "",
    "You are connected to a Chrome extension that exposes the user's active",
    "browser tab as a set of HTTPS tool endpoints. Each call runs in the page's",
    "main world (it sees the same JS globals as if you'd opened DevTools).",
    "",
    "**Start by calling `POST /page_info`** to see what's on screen. Then use",
    "`/dom_query` to find selectors, `/eval` to run arbitrary JS when you need",
    "to explore deeper, and `/click` / `/fill` / `/navigate` to drive.",
    "",
    profile?.notes ? `## Site notes (${host})\n\n${profile.notes}\n` : "",
    "## Tools",
    "",
    tooLines,
    "",
    "If you discover a stable interaction worth reusing on this site, call",
    "`/save_site_profile` to persist it — it'll be available as a first-class",
    "tool next time the user connects to this hostname.",
    "",
    "Each tool body is JSON. Errors come back as `{ error: { code, message } }`",
    "with non-2xx status. Keep results small; prefer targeted queries over",
    "wholesale DOM dumps.",
  ].filter(Boolean).join("\n")
}

// ── connection lifecycle ──────────────────────────────────────────

async function startConnect(opts) {
  // Keybind-driven flow passes opts.tabId to bind a specific (usually
  // background) tab. If a session already exists on a DIFFERENT tab, tear it
  // down first so the new keybind press is the active session. Same-tab
  // re-presses short-circuit.
  if (client && client.connected) {
    if (opts?.tabId && opts.tabId !== boundTabId) {
      await stopConnect()
    } else {
      return { status: "already_connected", info: lastStatus, url: lastUrl, token: lastToken }
    }
  }
  const base = opts?.base ?? (await chrome.storage.local.get("relay_base")).relay_base ?? DEFAULT_BASE

  // Capture which tab we're binding to. Keybind callers pass opts.tabId; the
  // popup path falls back to the user's currently-active tab.
  const activeTab = opts?.tabId
    ? await chrome.tabs.get(opts.tabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (!activeTab) throw new Error("no active tab to bind")
  boundTabId = activeTab.id
  lastProfile = await loadSiteProfileForUrl(activeTab.url)
  const host = (() => { try { return new URL(activeTab.url).host } catch { return "" } })()

  const baseTools = buildBaseTools({ getActiveTabId, getRecentConsole })
  const siteTools = buildSiteTools(lastProfile, getActiveTabId)
  const tools = [...baseTools, ...siteTools]
  const agentsMd = buildAgentsMd({ host, profile: lastProfile, tools })

  client = new ASClient({
    baseUrl: base,
    appId: "as_app_anon",
    appDescription: `Chrome extension driving an active tab on ${host || "unknown host"}.`,
    agentsMd,
    tools,
    onStatusChange: (s) => {
      lastStatus = s
      void chrome.storage.session?.set?.({ status: s }).catch(() => {})
      try { chrome.runtime.sendMessage({ type: "status", status: s }).catch(() => {}) } catch {}
    },
  })

  await client.connect()
  const link = await client.mintToken("chrome-extension")
  lastUrl = link.url
  lastToken = link.token
  await chrome.storage.local.set({ last_url: lastUrl, last_token: lastToken })
  return { status: "connected", info: lastStatus, url: lastUrl, token: lastToken, host, profile: lastProfile?.host ?? null, tool_count: tools.length }
}

async function stopConnect() {
  if (client) {
    try { client.close() } catch {}
    client = null
  }
  lastUrl = null
  lastToken = null
  lastStatus = { status: "idle" }
  boundTabId = null
  lastProfile = null
  await chrome.storage.local.remove(["last_url", "last_token"])
  return { status: "idle" }
}

async function snapshot() {
  return {
    status: lastStatus,
    url: lastUrl,
    token: lastToken,
    boundTabId,
    profileHost: lastProfile?.host ?? null,
    connected: client?.connected ?? false,
  }
}

// ── userScripts availability check ──────────────────────────────────
// chrome.userScripts is the privileged API used by /eval to bypass page CSP.
// It exists only when the user has toggled "Allow User Scripts" on this
// extension in chrome://extensions. Calling getScripts() is the cheapest way
// to distinguish (a) API not present (b) present but user-gated off (c) ready.
async function checkUserScripts() {
  if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") {
    return { available: false, reason: "api_unavailable",
      hint: "Your Chrome version doesn't expose chrome.userScripts.execute (need Chrome 135+)." }
  }
  try {
    await chrome.userScripts.getScripts()
    return { available: true }
  } catch (e) {
    return { available: false, reason: "user_toggle_off",
      hint: "Open chrome://extensions, find Agent Socket → Details → enable 'Allow User Scripts'.",
      error: e?.message ?? String(e) }
  }
}

// ── keybind-driven background-tab connect ──────────────────────────
// Each user-assigned shortcut fires `connect-slot-N`. We look up the slot's
// URL from chrome.storage.local.keybind_slots (managed by the agent via the
// /configure_keybind tool), open it in a background tab without focus-
// stealing, wait for the page to be scriptable, mint a session, copy the URL
// to the clipboard, and surface a desktop notification.

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (ok, err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      chrome.tabs.onRemoved.removeListener(removed)
      ok ? resolve() : reject(err)
    }
    const timer = setTimeout(() => done(false, new Error("tab load timeout")), timeoutMs)
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done(true)
    }
    function removed(id) {
      if (id === tabId) done(false, new Error("tab closed before load completed"))
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.onRemoved.addListener(removed)
    chrome.tabs.get(tabId).then((t) => {
      if (t?.status === "complete") done(true)
    }).catch((e) => done(false, e))
  })
}

let _offscreenSetup = null
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error("chrome.offscreen unavailable")
  if (_offscreenSetup) return _offscreenSetup
  _offscreenSetup = (async () => {
    const has = await chrome.offscreen.hasDocument?.()
    if (has) return
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["CLIPBOARD"],
      justification: "Copy minted agent-socket session URL after keybind connect.",
    })
  })()
  try { await _offscreenSetup } catch (e) { _offscreenSetup = null; throw e }
}

async function copyToClipboard(text) {
  try {
    await ensureOffscreen()
    const res = await chrome.runtime.sendMessage({ __as_target: "offscreen", type: "copy", text })
    return !!res?.ok
  } catch (e) {
    console.warn("[as-ext] copyToClipboard failed:", e)
    return false
  }
}

async function notify(title, message) {
  try {
    if (!chrome.notifications) return
    await new Promise((resolve) => {
      chrome.notifications.create("", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title,
        message: message ?? "",
        priority: 1,
      }, () => resolve())
    })
  } catch (e) { console.warn("[as-ext] notify failed:", e) }
}

async function connectViaSlot(slot) {
  const { keybind_slots = {} } = await chrome.storage.local.get("keybind_slots")
  const url = keybind_slots[String(slot)]
  if (!url) {
    await notify(`agent-socket slot ${slot}`, `No URL configured. Ask the agent to run /configure_keybind { slot: ${slot}, url: "https://…" }.`)
    return { ok: false, error: "slot_not_configured", slot }
  }
  let host = ""
  try { host = new URL(url).host } catch {}

  let tab
  try {
    tab = await chrome.tabs.create({ url, active: false })
  } catch (e) {
    await notify(`agent-socket slot ${slot}`, `Failed to open tab: ${e?.message ?? String(e)}`)
    return { ok: false, error: e?.message ?? String(e) }
  }

  try {
    await waitForTabComplete(tab.id, 25000)
  } catch (e) {
    await notify(`agent-socket slot ${slot}`, `Tab load timed out for ${host || url}.`)
    return { ok: false, error: "tab_load_timeout", url }
  }

  let res
  try {
    res = await startConnect({ tabId: tab.id })
  } catch (e) {
    await notify(`agent-socket slot ${slot}`, `Connect failed: ${e?.message ?? String(e)}`)
    return { ok: false, error: e?.message ?? String(e) }
  }

  const copied = await copyToClipboard(res.url ?? "")
  const tools = res.tool_count != null ? `${res.tool_count} tools` : "ready"
  const msg = copied
    ? `URL copied (${tools}). Paste into your AI.`
    : `URL: ${res.url}`
  await notify(`agent-socket: ${host || "session ready"}`, msg)
  return { ok: true, slot, url: res.url, tab_id: tab.id, copied }
}

chrome.commands?.onCommand?.addListener((command) => {
  const m = command?.match?.(/^connect-slot-(\d+)$/)
  if (!m) return
  void connectViaSlot(parseInt(m[1], 10))
})

// ── popup messaging ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Offscreen doc has its own listener for these; don't compete.
  if (msg?.__as_target === "offscreen") return false
  ;(async () => {
    try {
      if (msg?.type === "connect") sendResponse({ ok: true, ...(await startConnect(msg.opts)) })
      else if (msg?.type === "disconnect") sendResponse({ ok: true, ...(await stopConnect()) })
      else if (msg?.type === "snapshot") sendResponse({ ok: true, ...(await snapshot()) })
      else if (msg?.type === "list_profiles") {
        const stored = (await chrome.storage.local.get("site_profiles")).site_profiles ?? {}
        sendResponse({ ok: true, saved: Object.keys(stored), saved_full: stored })
      } else if (msg?.type === "delete_profile") {
        const all = (await chrome.storage.local.get("site_profiles")).site_profiles ?? {}
        delete all[msg.host]
        await chrome.storage.local.set({ site_profiles: all })
        sendResponse({ ok: true })
      } else if (msg?.type === "set_relay_base") {
        await chrome.storage.local.set({ relay_base: msg.base })
        sendResponse({ ok: true })
      } else if (msg?.type === "check_user_scripts") {
        sendResponse({ ok: true, ...(await checkUserScripts()) })
      } else if (msg?.type === "get_keybinds") {
        const slots = (await chrome.storage.local.get("keybind_slots")).keybind_slots ?? {}
        let commands = []
        try { commands = await chrome.commands.getAll() } catch {}
        sendResponse({ ok: true, slots, commands })
      } else if (msg?.type === "set_keybind") {
        const slot = msg.slot
        const url = msg.url
        if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
          sendResponse({ ok: false, error: "slot must be 1..4" })
        } else {
          const all = (await chrome.storage.local.get("keybind_slots")).keybind_slots ?? {}
          if (!url) delete all[String(slot)]
          else all[String(slot)] = String(url)
          await chrome.storage.local.set({ keybind_slots: all })
          sendResponse({ ok: true, slots: all })
        }
      } else {
        sendResponse({ ok: false, error: `unknown message: ${msg?.type}` })
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message ?? String(e) })
    }
  })()
  return true  // async response
})

// ── test/devtools surface ───────────────────────────────────────────
// Expose the lifecycle handlers on self so puppeteer can drive them via
// the service-worker target during E2E tests. No-op for normal users; this
// just mirrors what the popup already does via chrome.runtime.sendMessage.
self.__as_internal = {
  startConnect,
  stopConnect,
  snapshot,
  loadSiteProfileForUrl,
  getActiveTabId,
}

// ── keep-alive: MV3 service workers idle after 30s ─────────────────
// While we have a live client, ping the runtime to stay awake. The native WS
// already keeps the worker alive on inbound traffic, but our heartbeats are
// every 25s; an alarm every 25s gives extra margin.
chrome.alarms.create("as-keepalive", { periodInMinutes: 0.4 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "as-keepalive") {
    // Touching the client triggers no-op; presence keeps SW alive briefly.
    if (client?.connected) void chrome.storage.session?.set?.({ alive: Date.now() }).catch(() => {})
  }
})

// ── console capture: attach a small listener via content scripts ────
// We can't directly hook console.* across pages from a SW; instead, we inject
// a tiny logger on tab updates. It only sends back recent messages on demand
// (the agent calls /console_recent which forwards a request to the page).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return
  // The injected listener runs in MAIN world and stashes messages on window.
  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (window.__as_console_hook__) return
      window.__as_console_hook__ = true
      window.__as_console = []
      const orig = {}
      for (const lvl of ["log", "info", "warn", "error", "debug"]) {
        orig[lvl] = console[lvl].bind(console)
        console[lvl] = (...args) => {
          try {
            const text = args.map((a) => {
              try { return typeof a === "string" ? a : JSON.stringify(a) } catch { return String(a) }
            }).join(" ").slice(0, 1000)
            window.__as_console.push({ level: lvl, text, ts: Date.now() })
            if (window.__as_console.length > 500) window.__as_console.shift()
          } catch {}
          orig[lvl](...args)
        }
      }
    },
  }).catch(() => { /* not all pages allow injection */ })
})

// When the popup or a tool asks for recent console messages, pull them from
// the page. The /console_recent handler gets them via this mirror function.
async function pullConsoleFromPage(tabId, limit) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (limit) => (window.__as_console ?? []).slice(-limit),
      args: [limit],
    })
    return r?.result ?? []
  } catch { return [] }
}

// Patch the recent-console getter to actually fetch from the page. We declared
// it synchronously above (closure-bound); rebind via the global, which the
// base tools call. We do this by exporting from this module... but service
// workers don't allow circular module shenanigans. Simpler: replace the
// function used by getRecentConsole with an async one — but tools-base passes
// a synchronous reference. So tools-base/console_recent reads from
// consoleByTab; we update consoleByTab on demand. Cleaner alternative: when
// /console_recent is called, refresh consoleByTab via pullConsoleFromPage.

// Hook: every time the active tab changes or before tool dispatch, we refresh
// the console cache. We can't easily hook tool dispatch, so we periodically
// pull on an alarm. Cheap.
chrome.alarms.create("as-pull-console", { periodInMinutes: 0.25 })
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "as-pull-console") return
  const tabId = await getActiveTabId()
  if (!tabId) return
  const msgs = await pullConsoleFromPage(tabId, MAX_CONSOLE_PER_TAB)
  consoleByTab.set(tabId, msgs)
})
