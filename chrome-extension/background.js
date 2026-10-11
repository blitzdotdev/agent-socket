// Background service worker.
//
// Owns one WebSocket connection to the agent-socket relay per connected tab
// (up to MAX_SESSIONS), each with its own link. A session's tools are base
// tools + its tab's site profile: the registry's (fetched on Connect, generic
// fallback) plus a local profile the user kept. Tool handlers only ever touch
// their own session's tab, which shows a toolbar badge and an in-page pill
// (pill.js) while the session lasts. Each session ends on its own timer
// (60 min by default) and is locked to the sites the user allowed for it: the
// tab's origin at Connect, plus any they Allow later. Every tool call and
// session event goes into a local activity log (lib/activity.js, activity.html).

import { connect, endSession, exponentialBackoff } from "./lib/sdk/index.js"
import { BASE_TOOL_PATHS, buildBaseTools, buildSiteTools, userScriptsAvailable } from "./lib/tools-base.js"
import { buildAgentsMd, findLocalProfile, mergeSiteTools, sourceLabel } from "./lib/profiles.js"
import { DEFAULT_REGISTRY_BASE, buildRegistryTools, fetchSiteProfile } from "./lib/registry.js"
import { TIMER_CHOICES, deadlineFor, originAllowed, originLabel, originOf, sessionMinutes, shortLeft, timeLeft } from "./lib/limits.js"
import { createActivityStore, describeCall, eventSummary, levelOf, parseArgs } from "./lib/activity.js"

// ── state ──────────────────────────────────────────────────────────
// One tab session per connected tab (tabId → newTabSession()). Each has its
// own relay session and link, pill, badge, timer and site lock; its tool
// handlers close over it, so a call on one tab's link can only touch that tab.
const sessions = new Map()
const MAX_SESSIONS = 10
// How a tab's last session ended, when that's worth showing in its popup
// ({ status: "closed", reason }). Dropped on the tab's next Connect or close.
const ended = new Map()

function newTabSession(tabId) {
  return {
    tabId,                 // the one tab this session's tool calls may touch
    session: null,         // SDK Session — owns the WS to the relay
    status: { status: "connecting" },  // connecting | connected | disconnected | reconnect-failed
    base: null,            // relay base the session is on
    url: null,
    token: null,
    registry: null,        // { status, profile?, error?, hostname, base }: registry answer for the loaded tools
    source: null,          // where the live tools came from (popup "Tools: …" line)
    toolsKey: null,        // fingerprint of the registered tool set, to skip no-op updates
    toolsHost: null,       // host (with port) whose site tools are loaded
    toolCallAt: null,      // the relay serves agents.md/tools.json itself; tool calls are our only sign of the AI
    toolName: null,        // the tool of that call, for the pill ("last: click 2m ago")
    // Set when the link changed after the user already had one (the relay
    // refused a resume, so the SDK opened a new session with a new link):
    // { at, reason, closeCode?, offlineMs?, afterRestart? }. The old link only
    // gets 503 app_offline now, so the pill, popup and badge say so until the
    // user copies the new link or a tool call arrives on it.
    linkChanged: null,
    // Session timer + site lock (lib/limits.js), saved with the session.
    endsAt: null,          // when the session auto-stops (ms epoch), or null: no limit
    allowedOrigins: [],    // origins tool calls may act on
    anyOrigin: false,      // the user let the AI use any site in this tab
    connecting: null,      // in-flight connect, so double clicks don't open two sessions
    held: null,            // saved session the relay is holding while we wait to resume it
    resumeRetry: null,     // { timer, attempt }: pending retry of that resume
    swapTimer: null,
    toolsChain: Promise.resolve(),
  }
}
// Still the tab's current session (not stopped, not replaced by a new Connect).
const live = (ts) => sessions.get(ts.tabId) === ts

// Default relay base. Overridable in the popup via chrome.storage.local.relay_base.
const DEFAULT_BASE = "https://agentsocket.dev"
// Requested from the popup on Connect (a user gesture), not at install.
const SITE_ACCESS = { origins: ["<all_urls>"] }

// ── connection diagnostics ─────────────────────────────────────────
// The last few connection events, shown in the popup's Settings to debug
// real-world drops. Memory only (gone when the worker stops), never sent
// anywhere, and no links or secrets: session ids, close codes, reasons.
const EVENTS_MAX = 20
const events = []
function logEvent(type, detail = {}) {
  events.push({ at: Date.now(), type, ...detail })
  if (events.length > EVENTS_MAX) events.shift()
}
logEvent("worker_start")

// ── activity log ───────────────────────────────────────────────────
// What the AI did, for the user to review (activity.html): one entry per tool
// call, refused ones included, plus session events. chrome.storage.local on
// this computer only, 7 days, never sent anywhere. `activity_level` (popup
// Settings) decides how much of each call is kept.
const activity = createActivityStore(chrome.storage.local)
const PRUNE_ALARM = "as-activity-prune"

async function logCall(t, ctx, call, at, result, error) {
  try {
    const level = levelOf((await chrome.storage.local.get("activity_level")).activity_level)
    const d = describeCall({ method: ctx?.method ?? t.method ?? "POST", path: t.path, args: parseArgs(ctx?.body), result, error, level })
    await activity.add({ kind: "call", at, ms: Date.now() - at, session: call.session, host: call.host, level, ...d })
  } catch (e) { console.warn("[as-ext] activity log write failed:", e?.message ?? e) }
}

// `event`: a key of SESSION_EVENTS in lib/activity.js.
function logSession(ts, event, { session: sid = ts.session?.sessionId ?? null, host = ts.toolsHost ?? "", ...extra } = {}) {
  return activity.add({ kind: "session", event, session: sid, host, ...extra, summary: eventSummary({ event, host, ...extra }) })
    .catch((e) => console.warn("[as-ext] activity log write failed:", e?.message ?? e))
}

void activity.prune().catch(() => {})
chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 })

// ── helpers ────────────────────────────────────────────────────────

// SECURITY: a session's tool calls must ONLY ever touch its own tab. If the
// tab is gone or the session ended, fail closed — never substitute another tab.
const tabIdOf = (ts) => async () => {
  if (!live(ts)) return null
  try { return (await chrome.tabs.get(ts.tabId)).id } catch { return null }
}

async function getRegistryBase() {
  return ((await chrome.storage.local.get("registry_base")).registry_base || DEFAULT_REGISTRY_BASE).replace(/\/+$/, "")
}

// The tab the user is looking at: the active one in the current window, or
// (when our own page is in front, as in the e2e tests) the last one they used.
async function frontTab() {
  const own = chrome.runtime.getURL("")
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => !(t.url ?? "").startsWith(own))
  return tabs.find((t) => t.active) ?? tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0] ?? null
}

// ── site lock ──────────────────────────────────────────────────────
// Tool calls act only while the session's tab is on an allowed origin,
// checked on every call (links the AI clicked, redirects, /eval `location=`,
// the user browsing all land here). The registry tools don't touch the page,
// so they stay usable while paused.
const LOCK_EXEMPT = new Set(["/registry_search", "/registry_get", "/registry_submit"])
const lock = (ts) => ({ origins: ts.allowedOrigins, any: ts.anyOrigin })
const allowedLabel = (ts) => ts.allowedOrigins.length === 1 ? originLabel(ts.allowedOrigins[0]) : ts.allowedOrigins.length ? "the allowed sites" : null

// Why tool calls are refused on the session's tab at `url`, or null if they
// aren't. `from`: what the tab left; `origin`: what "Allow" would add (null if it can't).
function pauseInfo(ts, url) {
  if (originAllowed(url, lock(ts))) return null
  const origin = originOf(url)
  return { host: origin ? originLabel(origin) : hostOf(url), origin, from: allowedLabel(ts) }
}

const notAllowed = (ts, message, host) => ({
  status: 403,
  body: { error: { code: "origin_not_allowed", message, host, allowed_origins: ts.allowedOrigins } },
})

function pausedResponse(ts, url) {
  const p = pauseInfo(ts, url)
  const where = p.host ? `on ${p.host}` : "on a page"
  return notAllowed(ts, `The tab is now ${where}, which the user hasn't allowed for this session, so nothing was done. `
    + (p.origin ? `Ask the user to click "Allow ${p.host}" in the Agent Socket bar or popup, or to` : "Ask the user to")
    + ` bring the tab back to ${p.from ?? "an allowed site"}.`, p.host)
}

const navRefusal = (ts) => (url) => {
  if (originAllowed(url, lock(ts))) return null
  const host = hostOf(url)
  return notAllowed(ts, `Navigation to ${host} refused: the user hasn't allowed it for this session (allowed: ${ts.allowedOrigins.map(originLabel).join(", ") || "none"}). `
    + `Ask the user to allow it: they can open it in this tab and click "Allow ${host}" in the Agent Socket extension, or turn on "Let the AI use other sites in this tab".`, host)
}

// Injection target for a tool call, pinned to the document whose origin was
// checked: if the tab navigates after this, the injection fails instead of
// running on the next page.
const pinTab = (ts) => async (tabId) => {
  if (ts.anyOrigin) return { tabId }
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href })
  if (!originAllowed(r?.result, lock(ts))) throw Object.assign(new Error("origin_not_allowed"), { response: pausedResponse(ts, r?.result) })
  return { tabId, documentIds: [r.documentId] }
}

// ── session timer ──────────────────────────────────────────────────
// A chrome.alarms deadline per tab, so it fires even if the worker was
// stopped. On expiry: the same clean Stop as the Stop button.
const TIMER_ALARM = "as-session-end"
const timerAlarm = (tabId) => `${TIMER_ALARM}:${tabId}`
function setDeadline(ts, at) {
  ts.endsAt = at
  if (at == null) void chrome.alarms.clear(timerAlarm(ts.tabId))
  else chrome.alarms.create(timerAlarm(ts.tabId), { when: at })
}
const expired = (ts) => ts.endsAt != null && Date.now() >= ts.endsAt

// ── local site profiles ────────────────────────────────────────────
// The AI's /save_site_profile lands in `pending_profiles` and does nothing
// until the user clicks Keep in the popup, which moves it to `kept_profiles`.
// Only kept profiles load. Both are { [host]: { host, notes, tools, savedAt,
// keptAt? } } in chrome.storage.local. Read-modify-writes are serialized.
let profilesChain = Promise.resolve()

function withProfiles(fn) {
  const run = async () => {
    const st = await chrome.storage.local.get(["pending_profiles", "kept_profiles", "site_profiles"])
    const data = { pending: st.pending_profiles ?? {}, kept: st.kept_profiles ?? {} }
    let dirty = false
    // Before 0.3.0, AI saves went straight to `site_profiles` and loaded
    // without the user's say. Move them to pending so the user decides.
    if (st.site_profiles && typeof st.site_profiles === "object") {
      for (const [h, p] of Object.entries(st.site_profiles)) {
        if (!data.pending[h] && !data.kept[h] && p && Array.isArray(p.tools)) {
          data.pending[h] = { host: h, notes: typeof p.notes === "string" ? p.notes : "", tools: p.tools, savedAt: p.savedAt ?? Date.now() }
        }
      }
      dirty = true
    }
    const before = JSON.stringify(data)
    const value = await fn(data)
    if (dirty || JSON.stringify(data) !== before) {
      await chrome.storage.local.set({ pending_profiles: data.pending, kept_profiles: data.kept })
      if (dirty) await chrome.storage.local.remove("site_profiles")
    }
    return value
  }
  const p = profilesChain.then(run, run)
  profilesChain = p.catch(() => {})
  return p
}

function savePendingProfile(profile) {
  return withProfiles((d) => { d.pending[profile.host] = { ...profile, savedAt: Date.now() } })
}

const summarize = (p, withTools) => ({
  host: p.host,
  tool_count: p.tools?.length ?? 0,
  savedAt: p.savedAt ?? null,
  keptAt: p.keptAt ?? null,
  ...(withTools ? {
    notes: p.notes ?? "",
    tools: (p.tools ?? []).map((t) => ({ method: (t?.method ?? "POST").toUpperCase(), path: t?.path, description: t?.description, code: t?.code })),
  } : {}),
})

// ── tool set for a session's tab ───────────────────────────────────

// Every tool call: refused if the timer ran out or the tab is off the allowed
// sites, then run; either way written to the activity log.
const track = (ts) => (t) => ({ ...t, handler: async (ctx) => {
  const at = Date.now()
  const call = { session: ts.session?.sessionId ?? null, host: ts.toolsHost ?? "" }
  let result
  try {
    result = await guarded(ts, t, ctx, call)
  } catch (e) {
    await logCall(t, ctx, call, at, undefined, e)
    throw e
  }
  await logCall(t, ctx, call, at, result)
  return result
} })

async function guarded(ts, t, ctx, call) {
  if (expired(ts)) {
    void stopConnect(ts, "expired")
    return { status: 403, body: { error: { code: "session_expired", message: "The user's session timer ran out, so the session is ending. Ask the user to connect again if there is more to do." } } }
  }
  // A tool call can only arrive on the current link, so the AI has it.
  ts.toolCallAt = Date.now()
  ts.toolName = t.path.replace(/^\//, "")
  if (ts.linkChanged) void clearLinkChanged(ts, "tool_call")
  const tab = live(ts) ? await chrome.tabs.get(ts.tabId).catch(() => null) : null
  if (tab) call.host = hostOf(tab.url)
  if (!LOCK_EXEMPT.has(t.path) && tab && !originAllowed(tab.url, lock(ts))) return pausedResponse(ts, tab.url)
  return t.handler(ctx)
}

function baseTools(ts) {
  const getTabId = tabIdOf(ts)
  const sessionInfo = () => ({
    session_ends_at: ts.endsAt == null ? null : new Date(ts.endsAt).toISOString(),
    allowed_origins: ts.anyOrigin ? "any" : ts.allowedOrigins,
  })
  return [
    ...buildBaseTools({ getTabId, savePendingProfile, pinTab: pinTab(ts), navRefusal: navRefusal(ts), sessionInfo }),
    ...buildRegistryTools({
      getBase: getRegistryBase,
      getHostname: async () => {
        const id = await getTabId()
        return id ? hostnameOf((await chrome.tabs.get(id).catch(() => null))?.url) : ""
      },
      loadedHost: () => ts.registry?.profile?.host ?? null,
      basePaths: BASE_TOOL_PATHS,
      extVersion: chrome.runtime.getManifest().version,
    }),
  ]
}

// Base tools + registry profile + kept local profile (local wins on a
// METHOD+path clash) for `host` (with port), with the agents.md describing them.
async function computeToolSet(ts, host, registry) {
  const kept = await withProfiles((d) => d.kept)
  const local = findLocalProfile(kept, host, hostnameOf(`http://${host}`))
  const merged = mergeSiteTools(registry?.profile?.tools, local?.tools, BASE_TOOL_PATHS)
  if (merged.dropped.length) console.warn("[as-ext] skipped unusable site tools:", merged.dropped)
  const tools = [...baseTools(ts), ...buildSiteTools({ tools: merged.tools }, tabIdOf(ts), pinTab(ts))].map(track(ts))
  const agentsMd = buildAgentsMd({ host, registry, local, tools })
  const source = {
    registry: {
      status: registry?.status ?? "none",
      host: registry?.profile?.host ?? null,
      version: registry?.profile?.version ?? null,
      ...(registry?.error ? { error: registry.error } : {}),
    },
    local: local ? { host: local.host, count: merged.tools.filter((t) => t.source === "local").length } : null,
    total: tools.length,
  }
  const key = JSON.stringify([agentsMd, tools.map(({ handler, ...t }) => t), merged.tools.map((t) => t.code)])
  return { tools, agentsMd, source, key }
}

// Re-registers a session's tools on its live session (same URL): for the
// loaded host after a Keep or delete, or for another `host` + `registry` when
// the tab moved to another allowed site. Waits up to `waitMs` (the SDK holds
// an update made while reconnecting until the session is back, then applies
// it). One at a time per session.
function refreshLiveTools(ts, waitMs = 5000, host = ts.toolsHost, registry = ts.registry) {
  const p = ts.toolsChain.then(() => applyTools(ts, waitMs, host, registry))
  ts.toolsChain = p.catch(() => {})
  return p
}

async function applyTools(ts, waitMs, host, registry) {
  const s = ts.session
  if (!s || !live(ts) || host == null) return { live: false }
  const set = await computeToolSet(ts, host, registry)
  if (set.key === ts.toolsKey) return { live: true, changed: false }
  const applied = s.updateTools(set.tools, set.agentsMd).then(() => {
    if (s !== ts.session) return
    ts.toolsKey = set.key
    ts.source = set.source
    ts.registry = registry
    ts.toolsHost = host
    void saveSession(ts)
  })
  const timedOut = await Promise.race([
    applied.then(() => false),
    new Promise((r) => setTimeout(() => r(true), waitMs)),
  ])
  if (timedOut) {
    applied.catch((e) => console.warn("[as-ext] tool update failed:", e?.message ?? e))
    return { live: false, pending: true }
  }
  return { live: true, changed: true }
}

// A Keep or delete changes the tools of every session on that host.
async function refreshAllTools() {
  const results = await Promise.all([...sessions.values()].map((ts) => refreshLiveTools(ts).catch(() => ({ live: false }))))
  return { live: results.some((r) => r.live), pending: results.some((r) => r.pending) }
}

// ── indicator: per-tab badge + in-page pill ─────────────────────────

// "AI" while connected; "NEW" (amber) while the link changed and the user
// hasn't copied the new one yet.
async function updateBadge(ts) {
  const tabId = ts.tabId, changed = !!ts.linkChanged
  await chrome.action.setBadgeText({ tabId, text: changed ? "NEW" : "AI" }).catch(() => {})
  await chrome.action.setBadgeBackgroundColor({ tabId, color: changed ? "#fb4" : "#f06" }).catch(() => {})
  await chrome.action.setBadgeTextColor?.({ tabId, color: changed ? "#000" : "#fff" })?.catch(() => {})
  await chrome.action.setTitle({ tabId, title: changed ? "Agent Socket: your link changed. Click to copy the new one." : "Agent Socket" }).catch(() => {})
}

// Indicator updates run one at a time, and a show re-checks the session when
// its turn comes: otherwise a show started by a page load can land after
// Stop's hide and leave "AI" on a tab that is no longer connected.
let indicatorQueue = Promise.resolve()
function queueIndicator(fn) {
  indicatorQueue = indicatorQueue.then(fn, fn)
  return indicatorQueue
}

function showIndicator(ts) {
  return queueIndicator(async () => {
    if (!live(ts)) return
    await updateBadge(ts)
    await chrome.scripting.executeScript({ target: { tabId: ts.tabId }, files: ["pill.js"] }).catch(() => {})
  })
}

function hideIndicator(tabId) {
  return queueIndicator(async () => {
    if (sessions.has(tabId)) return  // a new session on the tab took over
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {})
    await chrome.action.setTitle({ tabId, title: "Agent Socket" }).catch(() => {})
    await chrome.tabs.sendMessage(tabId, { type: "as_pill_remove" }).catch(() => {})
  })
}

const refreshBadge = (ts) => queueIndicator(() => live(ts) ? updateBadge(ts) : undefined)

async function markLinkChanged(ts, info) {
  ts.linkChanged = { at: Date.now(), ...info }
  ts.toolCallAt = ts.toolName = null  // that activity was on the dead link
  await refreshBadge(ts)
}

// The user copied the new link (`via` popup / pill) or the AI used it (tool_call).
async function clearLinkChanged(ts, via) {
  if (!ts.linkChanged) return
  ts.linkChanged = null
  logEvent("link_acknowledged", { via, tab: ts.tabId })
  await refreshBadge(ts)
  await saveSession(ts)
}

// Navigations reset per-tab badges and drop the pill; put both back.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const ts = sessions.get(tabId)
  if (!ts) return
  if (info.status === "complete") void showIndicator(ts)
  if (info.url || info.status === "complete") scheduleToolSwap(ts)
})

// ── tools follow the tab across allowed sites ──────────────────────
// Once the tab settles on an allowed site other than the one whose tools are
// loaded, load that site's registry profile (+ kept local profile) on the
// same link. A paused tab keeps the loaded tools.
function scheduleToolSwap(ts, delay = 500) {
  clearTimeout(ts.swapTimer)
  ts.swapTimer = setTimeout(() => void swapTools(ts).catch((e) => console.warn("[as-ext] tool swap failed:", e?.message ?? e)), delay)
}

async function swapTools(ts) {
  const s = ts.session
  const tab = s && live(ts) ? await chrome.tabs.get(ts.tabId).catch(() => null) : null
  if (!tab || !originAllowed(tab.url, lock(ts))) return
  const host = hostOf(tab.url), hostname = hostnameOf(tab.url)
  if (!host || host === ts.toolsHost) return
  const base = await getRegistryBase()
  const registry = ts.registry?.hostname === hostname && ts.registry.base === base
    ? ts.registry
    : { ...(await fetchSiteProfile(base, hostname)), hostname, base }
  if (s !== ts.session) return
  logEvent("tools_swapped", { host, tab: ts.tabId })
  await refreshLiveTools(ts, 5000, host, registry)
}

chrome.tabs.onRemoved.addListener((tabId) => {
  ended.delete(tabId)
  const ts = sessions.get(tabId)
  if (ts) void stopConnect(ts, "tab_closed")
})

// ── surviving a service-worker restart ─────────────────────────────
// Chrome can stop this worker (and its WebSockets) at any time. Each live
// session is saved in chrome.storage.session under its tab (memory only,
// cleared when Chrome exits; not readable by content scripts), so a restarted
// worker can resume them all: the relay holds a dropped session (24 h on
// agentsocket.dev), and with the resume secret the SAME agent URL keeps
// working. If the relay can't be reached yet (laptop just woke, network
// down), a saved session is kept and retried with backoff, here and on every
// later worker start, until the relay answers: it then resumes, or refuses
// and a new link is made.
// `as_session:<tabId>` → { tabId, base, sessionId, secret, url, token, registry, linkChanged, endsAt, allowedOrigins, anyOrigin, toolsHost }
const SAVED_PREFIX = "as_session:"
const savedKey = (tabId) => `${SAVED_PREFIX}${tabId}`
const LEGACY_SAVED_KEY = "as_session"  // before 0.6.0: the one session

async function saveSession(ts) {
  if (!live(ts)) return
  const limits = { endsAt: ts.endsAt, allowedOrigins: ts.allowedOrigins, anyOrigin: ts.anyOrigin, toolsHost: ts.toolsHost }
  if (!ts.session) {
    // Still waiting to resume: keep the saved session, with the user's latest timer and sites.
    if (ts.held) {
      ts.held = { ...ts.held, ...limits }
      await chrome.storage.session.set({ [savedKey(ts.tabId)]: ts.held }).catch(() => {})
    }
    return
  }
  await chrome.storage.session.set({
    [savedKey(ts.tabId)]: {
      tabId: ts.tabId,
      base: ts.base,
      sessionId: ts.session.sessionId,
      secret: ts.session.resumeSecret,
      url: ts.url,
      token: ts.token,
      registry: ts.registry,
      linkChanged: ts.linkChanged,
      ...limits,
    },
  }).catch(() => {})
}

// Runs once per worker start. Message handlers wait for it, so the pill and
// popup never see "not connected" for a tab that is about to be resumed.
const restored = (async () => {
  const all = await chrome.storage.session.get(null).catch(() => ({}))
  const saved = Object.entries(all).filter(([k]) => k.startsWith(SAVED_PREFIX)).map(([, v]) => v)
  const legacy = all[LEGACY_SAVED_KEY]
  if (legacy) {
    await chrome.storage.session.remove(LEGACY_SAVED_KEY).catch(() => {})
    void chrome.alarms.clear(TIMER_ALARM)
    if (Number.isInteger(legacy.tabId) && !saved.some((v) => v.tabId === legacy.tabId)) {
      await chrome.storage.session.set({ [savedKey(legacy.tabId)]: legacy }).catch(() => {})
      saved.push(legacy)
    }
  }
  await Promise.all(saved.map(restoreSession))
})().catch(() => {})

async function restoreSession(saved) {
  if (sessions.has(saved.tabId)) return
  const tab = await chrome.tabs.get(saved.tabId).catch(() => null)
  if (!tab || !saved.sessionId || !saved.secret) {
    await chrome.storage.session.remove(savedKey(saved.tabId)).catch(() => {})
    if (tab) void hideIndicator(tab.id)
    return
  }
  const ts = newTabSession(tab.id)
  ts.held = saved
  ts.allowedOrigins = saved.allowedOrigins ?? [originOf(tab.url)].filter(Boolean)
  ts.anyOrigin = !!saved.anyOrigin
  ts.toolsHost = saved.toolsHost ?? null
  sessions.set(tab.id, ts)
  setDeadline(ts, saved.endsAt ?? null)
  // The timer ran out while the worker was stopped: end the held session.
  if (expired(ts)) return void stopConnect(ts, "expired")
  // Don't await: a slow resume mustn't hold up every message handler.
  startConnect(tab.id, saved).catch((e) => console.warn("[as-ext] resume after restart failed:", e?.message ?? e))
}

// ── connection lifecycle ──────────────────────────────────────────

// Connect `tabId`, or (`saved`) resume its session from before a worker restart.
function startConnect(tabId, saved) {
  const cur = sessions.get(tabId)
  if (cur?.connecting) return cur.connecting
  if (saved) {
    cur.connecting = doConnect(cur, saved).finally(() => { cur.connecting = null })
    return cur.connecting
  }
  if (cur?.session?.connected) return Promise.resolve(alreadyConnected(cur))
  if (!cur && sessions.size >= MAX_SESSIONS) {
    return Promise.reject(new Error(`${MAX_SESSIONS} tabs are already connected: stop one to connect this tab`))
  }
  // A session on this tab that isn't connected (reconnecting, or waiting to
  // resume) is replaced by a new one.
  const ts = newTabSession(tabId)
  sessions.set(tabId, ts)
  ended.delete(tabId)
  ts.connecting = (async () => {
    if (cur) await stopConnect(cur)
    return doConnect(ts)
  })().finally(() => { ts.connecting = null })
  return ts.connecting
}

const alreadyConnected = (ts) => ({ status: "already_connected", url: ts.url, host: ts.toolsHost, profile: ts.registry?.profile?.host ?? null, source: ts.source })

function cancelResumeRetry(ts) {
  if (ts.resumeRetry) clearTimeout(ts.resumeRetry.timer)
  ts.resumeRetry = null
}

// Failures that retrying can't fix. Anything else (the socket didn't open,
// dropped, or timed out before the relay answered) is the network or the relay.
function isPermanent(e) {
  return /^(no tab to bind|connect cancelled|site access not granted|register failed)/.test(e?.message ?? "")
}

// Retry a saved session's resume, backing off to 30 s between attempts.
function scheduleResumeRetry(ts, saved) {
  const attempt = (ts.resumeRetry?.attempt ?? 0) + 1
  const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5)
  if (ts.resumeRetry) clearTimeout(ts.resumeRetry.timer)
  ts.resumeRetry = {
    attempt,
    timer: setTimeout(() => {
      if (!live(ts) || ts.session) return
      startConnect(ts.tabId, saved).catch(() => {})
    }, delay),
  }
}

// Drops a session that never got going from the map (and its saved copy).
async function discard(ts, reason) {
  cancelResumeRetry(ts)
  clearTimeout(ts.swapTimer)
  if (!live(ts)) return
  sessions.delete(ts.tabId)
  void chrome.alarms.clear(timerAlarm(ts.tabId))
  if (reason) ended.set(ts.tabId, { status: "closed", reason })
  void hideIndicator(ts.tabId)
  await chrome.storage.session.remove(savedKey(ts.tabId)).catch(() => {})
}

// `saved`: a session from before a worker restart, to resume rather than start.
async function doConnect(ts, saved) {
  const tab = await chrome.tabs.get(ts.tabId).catch(() => null)
  if (!tab) {
    await discard(ts)
    throw new Error("no tab to bind")
  }
  if (!(await chrome.permissions.contains(SITE_ACCESS))) {
    const e = new Error("site access not granted — click Connect in the extension popup to allow it")
    await discard(ts, e.message)
    throw e
  }
  const settings = await chrome.storage.local.get(["relay_base", "session_minutes", "default_any_site", "test_session_ms"])
  const base = settings.relay_base || DEFAULT_BASE
  const resume = saved && saved.base === base ? { sessionId: saved.sessionId, secret: saved.secret } : undefined
  ts.base = base

  ts.toolCallAt = ts.toolName = null
  // A new session's timer counts from Connect and it is locked to this tab's
  // origin. (A saved one's were restored with it.) `test_session_ms`: a short
  // deadline for the e2e tests, settable only from devtools.
  if (!saved) {
    setDeadline(ts, settings.test_session_ms > 0 ? Date.now() + settings.test_session_ms : deadlineFor(sessionMinutes(settings.session_minutes), Date.now()))
    ts.allowedOrigins = [originOf(tab.url)].filter(Boolean)
    ts.anyOrigin = settings.default_any_site === true
  }
  // While resuming a saved session, its link (and any unacknowledged change)
  // stays on show: the relay is holding it.
  ts.linkChanged = saved?.linkChanged ?? null
  if (saved?.url) { ts.url = saved.url; ts.token = saved.token }
  // Tools for the tab's site; a resumed session that is paused keeps the ones it had.
  const host = !originAllowed(tab.url, lock(ts)) && ts.toolsHost ? ts.toolsHost : hostOf(tab.url)
  ts.status = { status: ts.resumeRetry ? "reconnect-failed" : "connecting" }

  const reconnectBackoff = exponentialBackoff()
  let s, registry, toolSet
  try {
    // The registry decides the shared tools. A resumed session reuses the
    // answer it was started with (same tools as before the restart); if the
    // registry is down, connect anyway with base + local tools.
    const hostname = hostnameOf(`http://${host}`)
    const registryBase = await getRegistryBase()
    registry = saved?.registry && saved.registry.hostname === hostname && saved.registry.base === registryBase
      ? saved.registry
      : { ...(await fetchSiteProfile(registryBase, hostname)), hostname, base: registryBase }
    if (!live(ts)) throw new Error("connect cancelled")
    toolSet = await computeToolSet(ts, host, registry)
    const { tools, agentsMd } = toolSet
    s = await connect({
      baseUrl: base,
      appId: "as_app_anon",
      appDescription: `Chrome extension driving one browser tab on ${host || "unknown host"}.`,
      agentsMd,
      tools,
      onDisconnect: (info) => {
        if (!live(ts) || (ts.session && s !== ts.session)) return info.giveUp()
        // attempt 1 = the WS just dropped; later = a reconnect attempt failed.
        logEvent(info.attempt === 1 ? "drop" : "retry_failed", { code: info.code, reason: info.reason, attempt: info.attempt, tab: ts.tabId })
        ts.status = { status: info.attempt === 1 ? "disconnected" : "reconnect-failed", reason: info.reason, attempt: info.attempt }
        reconnectBackoff(info)
      },
      // The usual reconnect resumes the same session: the URL is unchanged.
      onReconnect: ({ sessionId, resumed }) => {
        if (s !== ts.session || !resumed) return
        logEvent("resumed", { sessionId, tab: ts.tabId })
        ts.status = { status: "connected", sessionId }
        void saveSession(ts)
      },
      // The resume was refused, so the SDK opened a new session and re-minted
      // our token; pick up the new URL + token (or mint one if that failed),
      // and tell the user: the link they gave the AI is dead.
      onSessionChanged: async ({ priorSessionId, sessionId, tokensRemapped, reason, closeCode, offlineMs }) => {
        if (s !== ts.session) return
        if (sessionId !== priorSessionId) {
          logEvent(reason === "replaced" ? "replaced" : reason === "no_resume_secret" ? "no_resume" : "resume_refused", { code: closeCode, sessionId: priorSessionId, offlineMs, tab: ts.tabId })
          logEvent("new_session", { sessionId, tab: ts.tabId })
        } else {
          logEvent("reminted", { sessionId, tab: ts.tabId })
        }
        const priorUrl = ts.url
        try {
          const fresh = tokensRemapped.get(ts.url)
          const link = fresh
            ? (await s.listAgentTokens()).find((t) => t.url === fresh)
            : await s.mintAgentToken({ label: "chrome-extension" })
          ts.url = link?.url ?? null
          ts.token = link?.token ?? null
        } catch { ts.url = ts.token = null }
        if (priorUrl && ts.url !== priorUrl) {
          await markLinkChanged(ts, { reason: reason ?? "resume_refused", closeCode, offlineMs })
          void logSession(ts, "link_changed", { session: sessionId, prior: priorSessionId })
        }
        ts.status = { status: "connected", sessionId }
        await saveSession(ts)
      },
      resume,
    })
    if (!live(ts)) throw new Error("connect cancelled")  // tab closed or Stop pressed meanwhile
    // Resumed after a restart: keep the saved link if the relay still has it.
    const kept = resume && s.sessionId === resume.sessionId
      ? (await s.listAgentTokens()).find((t) => t.token === saved.token)
      : null
    const link = kept ?? await s.mintAgentToken({ label: "chrome-extension" })
    if (!live(ts)) throw new Error("connect cancelled")
    if (resume && s.sessionId === resume.sessionId) logEvent("resumed", { sessionId: s.sessionId, afterRestart: true, tab: ts.tabId })
    else if (resume) {
      // connect() falls back to a fresh session only when the relay refuses (4401).
      logEvent("resume_refused", { code: 4401, sessionId: resume.sessionId, afterRestart: true, tab: ts.tabId })
      logEvent("new_session", { sessionId: s.sessionId, tab: ts.tabId })
    } else {
      logEvent("connected", { sessionId: s.sessionId, tab: ts.tabId })
      void logSession(ts, "connected", { session: s.sessionId, host })
    }
    // After a worker restart: the user already had saved.url. Same link →
    // carry over a change they haven't acknowledged; a new one → it changed.
    if (saved?.url) {
      ts.linkChanged = kept ? saved.linkChanged ?? null
        : !resume ? { at: Date.now(), reason: "relay_changed", afterRestart: true }
        : s.sessionId === resume.sessionId ? { at: Date.now(), reason: "link_missing", afterRestart: true }
        : { at: Date.now(), reason: "resume_refused", closeCode: 4401, afterRestart: true }
    }
    if (saved?.url && !kept) void logSession(ts, "link_changed", { session: s.sessionId, prior: saved.sessionId })
    ts.session = s
    ts.held = null
    ts.url = link.url
    ts.token = link.token
    ts.registry = registry
    ts.source = toolSet.source
    ts.toolsKey = toolSet.key
    ts.toolsHost = host
  } catch (e) {
    s?.close()
    logEvent("connect_failed", { reason: e?.message ?? String(e), tab: ts.tabId })
    if (saved && live(ts) && !isPermanent(e)) {
      // Can't reach the relay yet. Keep the saved session (and the pill, now
      // "reconnecting…") and try again.
      scheduleResumeRetry(ts, saved)
      logEvent("resume_retry", { reason: e?.message ?? String(e), attempt: ts.resumeRetry.attempt, tab: ts.tabId })
      ts.status = { status: "reconnect-failed", reason: e?.message ?? String(e), attempt: ts.resumeRetry.attempt }
      void showIndicator(ts)
      throw e
    }
    await discard(ts, e?.message ?? String(e))
    throw e
  }
  cancelResumeRetry(ts)
  await saveSession(ts)
  ts.status = { status: "connected", sessionId: ts.session.sessionId }
  await showIndicator(ts)
  // A Keep or delete, or the tab moving to another site, while we were
  // connecting: pick it up (no-op otherwise).
  void refreshLiveTools(ts).catch(() => {})
  scheduleToolSwap(ts, 0)
  return { status: "connected", url: ts.url, host, profile: registry.profile?.host ?? null, source: toolSet.source, tool_count: toolSet.tools.length }
}

// `why`: "stopped" (the user, or a new Connect on the tab), "tab_closed" or "expired" (the timer).
async function stopConnect(ts, why = "stopped") {
  cancelResumeRetry(ts)
  clearTimeout(ts.swapTimer)
  const s = ts.session, token = ts.token, held = s ? null : ts.held, host = ts.toolsHost ?? ""
  // Reset synchronously: a connect in flight checks live(ts) after each await.
  const wasLive = live(ts)
  ts.session = ts.held = null
  if (wasLive) {
    sessions.delete(ts.tabId)
    void chrome.alarms.clear(timerAlarm(ts.tabId))
    if (why === "expired") ended.set(ts.tabId, { status: "closed", reason: "the session timer ran out" })
    else ended.delete(ts.tabId)
  }
  if (s || why === "expired") logEvent(why, { tab: ts.tabId })
  if (wasLive) await chrome.storage.session.remove(savedKey(ts.tabId)).catch(() => {})
  const sid = s?.sessionId ?? held?.sessionId
  if (sid) void logSession(ts, why, { session: sid, host })
  if (s) {
    // close() ends the session on the relay, killing every token; revoke first anyway.
    if (token && s.connected) await Promise.race([s.revokeAgentToken(token).catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
    s.close()
  } else if (held?.secret && held.sessionId) {
    // Stopped while still waiting to resume: the relay is holding it, so end it there too.
    void endSession({ baseUrl: held.base, sessionId: held.sessionId, secret: held.secret })
  }
  if (wasLive) await hideIndicator(ts.tabId)
  return { status: "idle" }
}

function hostOf(url) { try { return new URL(url).host } catch { return "" } }
function hostnameOf(url) { try { return new URL(url).hostname } catch { return "" } }

const tabInfo = (tab) => ({ id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl })

// The popup's view of `tabId`: its session if it has one, plus the other connected tabs.
async function snapshot(tabId) {
  const ts = sessions.get(tabId) ?? null
  const tab = ts ? await chrome.tabs.get(ts.tabId).catch(() => null) : null
  const others = []
  for (const o of sessions.values()) {
    if (o === ts) continue
    const t = await chrome.tabs.get(o.tabId).catch(() => null)
    if (t) others.push({ ...tabInfo(t), status: o.status.status, linkChanged: !!o.linkChanged })
  }
  return {
    tabId,
    status: ts?.status ?? ended.get(tabId) ?? { status: "idle" },
    url: ts?.url ?? null,
    connected: ts?.session?.connected ?? false,
    boundTab: tab && tabInfo(tab),
    profileHost: ts?.registry?.profile?.host ?? null,
    source: ts?.session ? ts.source : null,
    sourceLabel: ts?.session ? sourceLabel(ts.source) : "",
    lastToolCallAt: ts?.toolCallAt ?? null,
    lastTool: ts?.toolName ?? null,
    linkChanged: ts?.linkChanged ?? null,
    endsAt: ts?.endsAt ?? null,
    siteLock: ts ? { origins: ts.allowedOrigins, any: ts.anyOrigin } : null,
    paused: tab ? pauseInfo(ts, tab.url) : null,
    others,
    max: MAX_SESSIONS,
    events: events.slice(-10),
  }
}

// Our own pages (the popup) vs content scripts (the pill, in a connected tab's top frame).
const fromPopup = (sender) => sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""))
const pillTabId = (sender) => (sender.tab?.id != null && sender.frameId === 0 ? sender.tab.id : null)

// The tab a popup message is about: `msg.tabId`, else the tab in front.
async function popupTabId(msg) {
  return Number.isInteger(msg?.tabId) ? msg.tabId : (await frontTab())?.id ?? null
}

// The session a message acts on: the pill's own tab, or the tab the popup names.
async function sessionFor(msg, sender, { pill = false } = {}) {
  const tabId = fromPopup(sender) ? await popupTabId(msg) : pill ? pillTabId(sender) : null
  const ts = tabId == null ? null : sessions.get(tabId)
  if (!ts) throw new Error("not connected")
  return ts
}

// ── popup + pill messaging ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      await restored
      if (msg?.type === "connect") {
        const tabId = await popupTabId(msg)
        if (tabId == null) throw new Error("no tab to bind")
        sendResponse({ ok: true, ...(await startConnect(tabId)) })
      } else if (msg?.type === "disconnect") {
        const tabId = fromPopup(sender) ? await popupTabId(msg) : pillTabId(sender)
        const ts = tabId == null ? null : sessions.get(tabId)
        sendResponse({ ok: true, ...(ts ? await stopConnect(ts) : { status: "idle" }) })
      } else if (msg?.type === "snapshot") {
        sendResponse({ ok: true, ...(await snapshot(await popupTabId(msg))) })
      } else if (msg?.type === "pill_state") {
        const ts = sessions.get(pillTabId(sender))
        const left = ts ? timeLeft(ts.endsAt, Date.now()) : null
        sendResponse({
          bound: !!ts, status: ts?.status.status, lastToolCallAt: ts?.toolCallAt ?? null, lastTool: ts?.toolName ?? null, linkChanged: !!ts?.linkChanged,
          left: left == null ? null : shortLeft(left), soon: left != null && left < 60_000,
          paused: ts ? pauseInfo(ts, sender.tab.url) : null,
        })
      } else if (msg?.type === "set_timer") {
        // A new length from now (popup Change), or 0: no limit (Remove timer).
        if (!fromPopup(sender)) throw new Error("not connected")
        const ts = await sessionFor(msg, sender)
        const minutes = Number(msg.minutes)
        if (minutes !== 0 && !TIMER_CHOICES.includes(minutes)) throw new Error(`timer must be one of ${TIMER_CHOICES.join(", ")} minutes, or 0`)
        setDeadline(ts, deadlineFor(minutes, Date.now()))
        logEvent("timer_set", { minutes, tab: ts.tabId })
        void logSession(ts, "timer_set", { minutes })
        await saveSession(ts)
        sendResponse({ ok: true, endsAt: ts.endsAt })
      } else if (msg?.type === "allow_origin") {
        // "Allow <host>": adds the origin the tab is on now, which must be the
        // one the button showed.
        const ts = await sessionFor(msg, sender, { pill: true })
        const tab = await chrome.tabs.get(ts.tabId).catch(() => null)
        const origin = originOf(tab?.url)
        if (!origin || origin !== msg.origin) throw new Error("the tab is no longer on that site")
        if (!ts.allowedOrigins.includes(origin)) ts.allowedOrigins = [...ts.allowedOrigins, origin]
        logEvent("origin_allowed", { host: originLabel(origin), tab: ts.tabId })
        void logSession(ts, "origin_allowed", { site: originLabel(origin) })
        await saveSession(ts)
        scheduleToolSwap(ts, 0)
        sendResponse({ ok: true })
      } else if (msg?.type === "remove_origin") {
        if (!fromPopup(sender)) throw new Error("not connected")
        const ts = await sessionFor(msg, sender)
        if (ts.allowedOrigins.includes(msg.origin)) void logSession(ts, "origin_removed", { site: originLabel(msg.origin) })
        ts.allowedOrigins = ts.allowedOrigins.filter((o) => o !== msg.origin)
        await saveSession(ts)
        sendResponse({ ok: true })
      } else if (msg?.type === "set_any_origin") {
        if (!fromPopup(sender)) throw new Error("not connected")
        const ts = await sessionFor(msg, sender)
        ts.anyOrigin = msg.any === true
        logEvent("any_origin", { on: ts.anyOrigin, tab: ts.tabId })
        void logSession(ts, "any_origin", { on: ts.anyOrigin })
        await saveSession(ts)
        scheduleToolSwap(ts, 0)
        sendResponse({ ok: true })
      } else if (msg?.type === "pill_link") {
        // Only to the pill in its own tab's top frame (our content script;
        // page scripts can't message the extension). It never enters the DOM.
        const ts = sessions.get(pillTabId(sender))
        sendResponse(ts?.url ? { ok: true, url: ts.url } : { ok: false })
      } else if (msg?.type === "ack_link") {
        const ts = await sessionFor(msg, sender, { pill: true }).catch(() => null)
        if (ts) await clearLinkChanged(ts, msg.via === "pill" ? "pill" : "popup")
        sendResponse({ ok: true })
      } else if (msg?.type === "open_popup") {
        // The pill's fallback when it can't write the clipboard itself.
        sendResponse({ ok: await chrome.action.openPopup().then(() => true, () => false) })
      } else if (msg?.type === "list_profiles") {
        const { pending, kept } = await withProfiles((d) => d)
        const bySaved = (a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)
        sendResponse({
          ok: true,
          pending: Object.values(pending).sort(bySaved).map((p) => summarize(p, true)),
          kept: Object.values(kept).sort(bySaved).map((p) => summarize(p, false)),
        })
      } else if (msg?.type === "keep_profile") {
        const found = await withProfiles((d) => {
          const p = d.pending[msg.host]
          if (!p) return false
          delete d.pending[msg.host]
          d.kept[msg.host] = { ...p, keptAt: Date.now() }
          return true
        })
        if (!found) throw new Error(`no pending profile for ${msg.host}`)
        sendResponse({ ok: true, ...(await refreshAllTools()) })
      } else if (msg?.type === "discard_profile") {
        await withProfiles((d) => { delete d.pending[msg.host] })
        sendResponse({ ok: true })
      } else if (msg?.type === "delete_profile") {
        await withProfiles((d) => { delete d.kept[msg.host] })
        sendResponse({ ok: true, ...(await refreshAllTools()) })
      } else if (msg?.type === "set_registry_base") {
        const base = String(msg.base ?? "").trim()
        if (base && !/^https?:\/\/[^/\s]+/.test(base)) throw new Error("registry URL must start with http:// or https://")
        if (base) await chrome.storage.local.set({ registry_base: base.replace(/\/+$/, "") })
        else await chrome.storage.local.remove("registry_base")
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
// run through the SW, keeping it (and therefore the WebSockets) alive.
//
// Chrome MV3 clamps periodInMinutes to a minimum of 0.5 (30s). The relay's
// HEARTBEAT_TIMEOUT_MS is 50s, so a 30s alarm keeps the connections alive.
chrome.alarms.create("as-keepalive", { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "as-keepalive") for (const ts of sessions.values()) if (ts.session?.connected) ts.session.ping()
  if (a.name === PRUNE_ALARM) void activity.prune().catch(() => {})
  if (a.name.startsWith(`${TIMER_ALARM}:`)) {
    const tabId = Number(a.name.slice(TIMER_ALARM.length + 1))
    void restored.then(() => {
      const ts = sessions.get(tabId)
      if (ts?.endsAt == null) return
      if (Date.now() >= ts.endsAt - 1000) void stopConnect(ts, "expired")
      else setDeadline(ts, ts.endsAt)  // fired early: re-arm
    })
  }
})
