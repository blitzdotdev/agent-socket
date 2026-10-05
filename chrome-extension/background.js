// Background service worker.
//
// Owns the WebSocket connection to the agent-socket relay. Builds the tool
// list from base tools + the bound tab's site profile (if any). Tool handlers
// only ever touch the bound tab, which shows a toolbar badge and an in-page
// pill (pill.js) while the session lasts.

import { connect, exponentialBackoff } from "./lib/sdk/index.js"
import { buildBaseTools, buildSiteTools, userScriptsAvailable } from "./lib/tools-base.js"

// ── state ──────────────────────────────────────────────────────────
let session = null         // SDK Session — owns the WS to the relay
let lastStatus = { status: "idle" }  // idle | connecting | connected | disconnected | reconnect-failed | closed
let lastUrl = null
let lastToken = null
let lastProfile = null     // site profile loaded for the bound tab
let boundTabId = null      // the one tab tool calls may touch
let lastToolCallAt = null  // the relay serves agents.md/tools.json itself; tool calls are our only sign of the AI
let connecting = null      // in-flight startConnect, so double clicks don't open two sessions
let lastBase = null        // relay base the session is on

// Default relay base. Overridable in the popup via chrome.storage.local.relay_base.
const DEFAULT_BASE = "https://agentsocket.dev"
// Requested from the popup on Connect (a user gesture), not at install.
const SITE_ACCESS = { origins: ["<all_urls>"] }

// ── helpers ────────────────────────────────────────────────────────

async function getBoundTabId() {
  // SECURITY: tool calls must ONLY ever touch the bound tab. If it's gone,
  // fail closed — never substitute whatever tab the user is looking at.
  if (boundTabId == null) return null
  try { return (await chrome.tabs.get(boundTabId)).id } catch { return null }
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
    `# Agent Socket — driving \`${host || "a browser tab"}\``,
    "",
    "You are connected to a Chrome extension that exposes one browser tab the",
    "user chose as a set of HTTPS tool endpoints. Each call runs in the page's",
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

// ── indicator: per-tab badge + in-page pill ─────────────────────────

async function showIndicator(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "AI" }).catch(() => {})
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#f06" }).catch(() => {})
  await chrome.scripting.executeScript({ target: { tabId }, files: ["pill.js"] }).catch(() => {})
}

async function hideIndicator(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {})
  await chrome.tabs.sendMessage(tabId, { type: "as_pill_remove" }).catch(() => {})
}

// Navigations reset per-tab badges and drop the pill; put both back.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === boundTabId && info.status === "complete") void showIndicator(tabId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === boundTabId) void stopConnect()
})

// ── surviving a service-worker restart ─────────────────────────────
// Chrome can stop this worker (and its WebSocket) at any time. The live
// session is saved in chrome.storage.session (memory only, cleared when Chrome
// exits; not readable by content scripts), so a restarted worker can resume
// it: the relay holds a dropped session for a grace window, and with the
// resume secret the SAME agent URL keeps working.
const SAVED_KEY = "as_session"  // { tabId, base, sessionId, secret, url, token }

async function saveSession() {
  if (!session || boundTabId == null) return
  await chrome.storage.session.set({
    [SAVED_KEY]: {
      tabId: boundTabId,
      base: lastBase,
      sessionId: session.sessionId,
      secret: session.resumeSecret,
      url: lastUrl,
      token: lastToken,
    },
  }).catch(() => {})
}

// Runs once per worker start. Message handlers wait for it, so the pill and
// popup never see "not bound" for a tab that is about to be resumed.
const restored = (async () => {
  const saved = (await chrome.storage.session.get(SAVED_KEY).catch(() => ({})))[SAVED_KEY]
  if (!saved || boundTabId != null) return
  const tab = await chrome.tabs.get(saved.tabId).catch(() => null)
  if (!tab || !saved.sessionId || !saved.secret) {
    await chrome.storage.session.remove(SAVED_KEY).catch(() => {})
    if (tab) void hideIndicator(tab.id)
    return
  }
  boundTabId = tab.id
  emitStatus({ status: "connecting" })
  // Don't await: a slow resume mustn't hold up every message handler.
  startConnect(tab.id, saved).catch((e) => console.warn("[as-ext] resume after restart failed:", e?.message ?? e))
})().catch(() => {})

// ── connection lifecycle ──────────────────────────────────────────

function startConnect(tabId, saved) {
  connecting ??= doConnect(tabId, saved).finally(() => { connecting = null })
  return connecting
}

// `saved`: a session from before a worker restart, to resume rather than start.
async function doConnect(tabId, saved) {
  const tab = tabId != null
    ? await chrome.tabs.get(tabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (!tab) throw new Error("no tab to bind")
  if (session) {
    if (tab.id === boundTabId && session.connected) {
      return { status: "already_connected", url: lastUrl, host: hostOf(tab.url), profile: lastProfile?.host ?? null }
    }
    await stopConnect()
  }
  if (!(await chrome.permissions.contains(SITE_ACCESS))) {
    throw new Error("site access not granted — click Connect in the extension popup to allow it")
  }
  const base = (await chrome.storage.local.get("relay_base")).relay_base || DEFAULT_BASE
  const resume = saved && saved.base === base ? { sessionId: saved.sessionId, secret: saved.secret } : undefined
  lastBase = base

  boundTabId = tab.id
  lastToolCallAt = null
  lastProfile = await loadSiteProfileForUrl(tab.url)
  const host = hostOf(tab.url)

  const tools = [
    ...buildBaseTools({ getTabId: getBoundTabId }),
    ...buildSiteTools(lastProfile, getBoundTabId),
  ].map((t) => ({ ...t, handler: (ctx) => { lastToolCallAt = Date.now(); return t.handler(ctx) } }))
  const agentsMd = buildAgentsMd({ host, profile: lastProfile, tools })

  emitStatus({ status: "connecting" })
  const reconnectBackoff = exponentialBackoff()
  let s
  try {
    s = await connect({
      baseUrl: base,
      appId: "as_app_anon",
      appDescription: `Chrome extension driving one browser tab on ${host || "unknown host"}.`,
      agentsMd,
      tools,
      onDisconnect: (info) => {
        if (session && s !== session) return info.giveUp()
        // attempt 1 = the WS just dropped; later = a reconnect attempt failed.
        emitStatus({ status: info.attempt === 1 ? "disconnected" : "reconnect-failed", reason: info.reason, attempt: info.attempt })
        reconnectBackoff(info)
      },
      // The usual reconnect resumes the same session: the URL is unchanged.
      onReconnect: ({ sessionId, resumed }) => {
        if (s !== session || !resumed) return
        emitStatus({ status: "connected", sessionId })
        void saveSession()
      },
      // The resume was refused, so the SDK opened a new session and re-minted
      // our token; pick up the new URL + token (or mint one if that failed).
      onSessionChanged: async ({ sessionId, tokensRemapped }) => {
        if (s !== session) return
        try {
          const fresh = tokensRemapped.get(lastUrl)
          const link = fresh
            ? (await s.listAgentTokens()).find((t) => t.url === fresh)
            : await s.mintAgentToken({ label: "chrome-extension" })
          lastUrl = link?.url ?? null
          lastToken = link?.token ?? null
        } catch { lastUrl = lastToken = null }
        emitStatus({ status: "connected", sessionId })
        await saveSession()
      },
      resume,
    })
    if (boundTabId !== tab.id) throw new Error("connect cancelled")  // tab closed or Stop pressed meanwhile
    // Resumed after a restart: keep the saved link if the relay still has it.
    const kept = resume && s.sessionId === resume.sessionId
      ? (await s.listAgentTokens()).find((t) => t.token === saved.token)
      : null
    const link = kept ?? await s.mintAgentToken({ label: "chrome-extension" })
    if (boundTabId !== tab.id) throw new Error("connect cancelled")
    session = s
    lastUrl = link.url
    lastToken = link.token
  } catch (e) {
    s?.close()
    if (boundTabId === tab.id) {
      boundTabId = null; lastProfile = null; void hideIndicator(tab.id)
      await chrome.storage.session.remove(SAVED_KEY).catch(() => {})
    }
    emitStatus({ status: "closed", reason: e?.message ?? String(e) })
    throw e
  }
  await saveSession()
  emitStatus({ status: "connected", sessionId: session.sessionId })
  await showIndicator(tab.id)
  return { status: "connected", url: lastUrl, host, profile: lastProfile?.host ?? null, tool_count: tools.length }
}

async function stopConnect() {
  const s = session, token = lastToken, tabId = boundTabId
  session = null
  lastUrl = lastToken = lastProfile = lastToolCallAt = null
  boundTabId = null
  emitStatus({ status: "idle" })
  await chrome.storage.session.remove(SAVED_KEY).catch(() => {})
  if (s) {
    // close() ends the session on the relay, killing every token; revoke first anyway.
    if (token && s.connected) await Promise.race([s.revokeAgentToken(token).catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
    s.close()
  }
  if (tabId != null) await hideIndicator(tabId)
  return { status: "idle" }
}

function emitStatus(s) { lastStatus = s }

function hostOf(url) { try { return new URL(url).host } catch { return "" } }

async function snapshot() {
  const tab = boundTabId != null ? await chrome.tabs.get(boundTabId).catch(() => null) : null
  return {
    status: lastStatus,
    url: lastUrl,
    connected: session?.connected ?? false,
    boundTab: tab && { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl },
    profileHost: lastProfile?.host ?? null,
    lastToolCallAt,
  }
}

// ── popup + pill messaging ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      await restored
      if (msg?.type === "connect") sendResponse({ ok: true, ...(await startConnect(msg.tabId)) })
      else if (msg?.type === "disconnect") sendResponse({ ok: true, ...(await stopConnect()) })
      else if (msg?.type === "snapshot") sendResponse({ ok: true, ...(await snapshot()) })
      else if (msg?.type === "pill_state") {
        sendResponse({ bound: sender.tab?.id != null && sender.tab.id === boundTabId, status: lastStatus.status, lastToolCallAt })
      } else if (msg?.type === "list_profiles") {
        const stored = (await chrome.storage.local.get("site_profiles")).site_profiles ?? {}
        sendResponse({ ok: true, saved: Object.keys(stored) })
      } else if (msg?.type === "delete_profile") {
        const all = (await chrome.storage.local.get("site_profiles")).site_profiles ?? {}
        delete all[msg.host]
        await chrome.storage.local.set({ site_profiles: all })
        sendResponse({ ok: true })
      } else if (msg?.type === "check_user_scripts") {
        sendResponse({ ok: true, available: userScriptsAvailable() })
      } else if (msg?.type === "set_relay_base") {
        await chrome.storage.local.set({ relay_base: msg.base })
        sendResponse({ ok: true })
      } else {
        sendResponse({ ok: false, error: `unknown message: ${msg?.type}` })
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message ?? String(e) })
    }
  })()
  return true  // async response
})

// ── keep-alive: MV3 service workers idle-kill after ~30s ──────────
// Chrome wakes the SW briefly when an alarm fires, but the SW goes right
// back to sleep unless something exercises it. Calling session.ping() sends
// a real WS ping frame — the outbound write + the inbound pong dispatch both
// run through the SW, keeping it (and therefore the WebSocket) alive.
//
// Chrome MV3 clamps periodInMinutes to a minimum of 0.5 (30s). The relay's
// HEARTBEAT_TIMEOUT_MS is 50s, so a 30s alarm keeps the connection alive.
chrome.alarms.create("as-keepalive", { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "as-keepalive" && session?.connected) session.ping()
})
