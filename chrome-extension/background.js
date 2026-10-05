// Background service worker.
//
// Owns the WebSocket connection to the agent-socket relay. Builds the tool
// list from base tools + the bound tab's site profile: the registry's (fetched
// on Connect, generic fallback) plus a local profile the user kept. Tool
// handlers only ever touch the bound tab, which shows a toolbar badge and an
// in-page pill (pill.js) while the session lasts. Each session ends on a timer
// (60 min by default) and is locked to the sites the user allowed: the tab's
// origin at Connect, plus any they Allow later.

import { connect, endSession, exponentialBackoff } from "./lib/sdk/index.js"
import { BASE_TOOL_PATHS, buildBaseTools, buildSiteTools, userScriptsAvailable } from "./lib/tools-base.js"
import { buildAgentsMd, findLocalProfile, mergeSiteTools, sourceLabel } from "./lib/profiles.js"
import { DEFAULT_REGISTRY_BASE, buildRegistryTools, fetchSiteProfile } from "./lib/registry.js"
import { TIMER_CHOICES, deadlineFor, originAllowed, originLabel, originOf, sessionMinutes, shortLeft, timeLeft } from "./lib/limits.js"

// ── state ──────────────────────────────────────────────────────────
let session = null         // SDK Session — owns the WS to the relay
let lastStatus = { status: "idle" }  // idle | connecting | connected | disconnected | reconnect-failed | closed
let lastUrl = null
let lastToken = null
let lastRegistry = null    // { status, profile?, error?, hostname, base }: registry answer at Connect
let lastSource = null      // where the live tools came from (popup "Tools: …" line)
let lastToolsKey = null    // fingerprint of the registered tool set, to skip no-op updates
let boundTabId = null      // the one tab tool calls may touch
let lastToolCallAt = null  // the relay serves agents.md/tools.json itself; tool calls are our only sign of the AI
let connecting = null      // in-flight startConnect, so double clicks don't open two sessions
let lastBase = null        // relay base the session is on
// Set when the bound tab's link changed after the user already had one (the
// relay refused a resume, so the SDK opened a new session with a new link):
// { at, reason, closeCode?, offlineMs?, afterRestart? }. The old link only gets
// 503 app_offline now, so the pill, popup and badge say so until the user
// copies the new link or a tool call arrives on it.
let linkChanged = null
// Session timer + site lock (lib/limits.js), saved with the session.
let endsAt = null          // when the session auto-stops (ms epoch), or null: no limit
let allowedOrigins = []    // origins tool calls may act on
let anyOrigin = false      // the user let the AI use any site in this tab
let toolsHost = null       // host (with port) whose site tools are loaded

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

// ── helpers ────────────────────────────────────────────────────────

async function getBoundTabId() {
  // SECURITY: tool calls must ONLY ever touch the bound tab. If it's gone,
  // fail closed — never substitute whatever tab the user is looking at.
  if (boundTabId == null) return null
  try { return (await chrome.tabs.get(boundTabId)).id } catch { return null }
}

async function getRegistryBase() {
  return ((await chrome.storage.local.get("registry_base")).registry_base || DEFAULT_REGISTRY_BASE).replace(/\/+$/, "")
}

// ── site lock ──────────────────────────────────────────────────────
// Tool calls act only while the bound tab is on an allowed origin, checked
// on every call (links the AI clicked, redirects, /eval `location=`, the user
// browsing all land here). The registry tools don't touch the page, so they
// stay usable while paused.
const LOCK_EXEMPT = new Set(["/registry_search", "/registry_get", "/registry_submit"])
const lock = () => ({ origins: allowedOrigins, any: anyOrigin })
const allowedLabel = () => allowedOrigins.length === 1 ? originLabel(allowedOrigins[0]) : allowedOrigins.length ? "the allowed sites" : null

// Why tool calls are refused on the bound tab at `url`, or null if they aren't.
// `from`: what the tab left; `origin`: what "Allow" would add (null if it can't).
function pauseInfo(url) {
  if (originAllowed(url, lock())) return null
  const origin = originOf(url)
  return { host: origin ? originLabel(origin) : hostOf(url), origin, from: allowedLabel() }
}

const notAllowed = (message, host) => ({
  status: 403,
  body: { error: { code: "origin_not_allowed", message, host, allowed_origins: allowedOrigins } },
})

function pausedResponse(url) {
  const p = pauseInfo(url)
  const where = p.host ? `on ${p.host}` : "on a page"
  return notAllowed(`The tab is now ${where}, which the user hasn't allowed for this session, so nothing was done. `
    + (p.origin ? `Ask the user to click "Allow ${p.host}" in the Agent Socket bar or popup, or to` : "Ask the user to")
    + ` bring the tab back to ${p.from ?? "an allowed site"}.`, p.host)
}

function navRefusal(url) {
  if (originAllowed(url, lock())) return null
  const host = hostOf(url)
  return notAllowed(`Navigation to ${host} refused: the user hasn't allowed it for this session (allowed: ${allowedOrigins.map(originLabel).join(", ") || "none"}). `
    + `Ask the user to allow it: they can open it in this tab and click "Allow ${host}" in the Agent Socket extension, or turn on "Let the AI use other sites in this tab".`, host)
}

async function tabRefusal() {
  const tab = boundTabId != null ? await chrome.tabs.get(boundTabId).catch(() => null) : null
  return tab && !originAllowed(tab.url, lock()) ? pausedResponse(tab.url) : null
}

// Injection target for a tool call, pinned to the document whose origin was
// checked: if the tab navigates after this, the injection fails instead of
// running on the next page.
async function pinTab(tabId) {
  if (anyOrigin) return { tabId }
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href })
  if (!originAllowed(r?.result, lock())) throw Object.assign(new Error("origin_not_allowed"), { response: pausedResponse(r?.result) })
  return { tabId, documentIds: [r.documentId] }
}

// ── session timer ──────────────────────────────────────────────────
// A chrome.alarms deadline, so it fires even if the worker was stopped. On
// expiry: the same clean Stop as the Stop button.
const TIMER_ALARM = "as-session-end"
function setDeadline(at) {
  endsAt = at
  if (at == null) void chrome.alarms.clear(TIMER_ALARM)
  else chrome.alarms.create(TIMER_ALARM, { when: at })
}
const expired = () => endsAt != null && Date.now() >= endsAt

function resetLimits() {
  setDeadline(null)
  allowedOrigins = []
  anyOrigin = false
  toolsHost = null
  clearTimeout(swapTimer)
}

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

// ── tool set for the bound tab ─────────────────────────────────────

// A tool call can only arrive on the current link, so the AI has it.
const track = (t) => ({ ...t, handler: async (ctx) => {
  if (expired()) {
    void stopConnect("expired")
    return { status: 403, body: { error: { code: "session_expired", message: "The user's session timer ran out, so the session is ending. Ask the user to connect again if there is more to do." } } }
  }
  lastToolCallAt = Date.now()
  if (linkChanged) void clearLinkChanged("tool_call")
  if (!LOCK_EXEMPT.has(t.path)) {
    const refused = await tabRefusal()
    if (refused) return refused
  }
  return t.handler(ctx)
} })

const sessionInfo = () => ({
  session_ends_at: endsAt == null ? null : new Date(endsAt).toISOString(),
  allowed_origins: anyOrigin ? "any" : allowedOrigins,
})

function baseTools() {
  return [
    ...buildBaseTools({ getTabId: getBoundTabId, savePendingProfile, pinTab, navRefusal, sessionInfo }),
    ...buildRegistryTools({
      getBase: getRegistryBase,
      getHostname: async () => {
        const id = await getBoundTabId()
        return id ? hostnameOf((await chrome.tabs.get(id).catch(() => null))?.url) : ""
      },
      loadedHost: () => lastRegistry?.profile?.host ?? null,
      basePaths: BASE_TOOL_PATHS,
      extVersion: chrome.runtime.getManifest().version,
    }),
  ]
}

// Base tools + registry profile + kept local profile (local wins on a
// METHOD+path clash) for `host` (with port), with the agents.md describing them.
async function computeToolSet(host, registry) {
  const kept = await withProfiles((d) => d.kept)
  const local = findLocalProfile(kept, host, hostnameOf(`http://${host}`))
  const merged = mergeSiteTools(registry?.profile?.tools, local?.tools, BASE_TOOL_PATHS)
  if (merged.dropped.length) console.warn("[as-ext] skipped unusable site tools:", merged.dropped)
  const tools = [...baseTools(), ...buildSiteTools({ tools: merged.tools }, getBoundTabId, pinTab)].map(track)
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

// Re-registers the session's tools on the live session (same URL): for the
// loaded host after a Keep or delete, or for another `host` + `registry` when
// the tab moved to another allowed site. Waits up to `waitMs` (the SDK holds
// an update made while reconnecting until the session is back, then applies
// it). One at a time.
let toolsChain = Promise.resolve()
function refreshLiveTools(waitMs = 5000, host = toolsHost, registry = lastRegistry) {
  const p = toolsChain.then(() => applyTools(waitMs, host, registry))
  toolsChain = p.catch(() => {})
  return p
}

async function applyTools(waitMs, host, registry) {
  const s = session
  if (!s || boundTabId == null || host == null) return { live: false }
  const set = await computeToolSet(host, registry)
  if (set.key === lastToolsKey) return { live: true, changed: false }
  const applied = s.updateTools(set.tools, set.agentsMd).then(() => {
    if (s !== session) return
    lastToolsKey = set.key
    lastSource = set.source
    lastRegistry = registry
    toolsHost = host
    void saveSession()
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

// ── indicator: per-tab badge + in-page pill ─────────────────────────

// "AI" while connected; "NEW" (amber) while the link changed and the user
// hasn't copied the new one yet.
async function updateBadge(tabId) {
  const changed = !!linkChanged
  await chrome.action.setBadgeText({ tabId, text: changed ? "NEW" : "AI" }).catch(() => {})
  await chrome.action.setBadgeBackgroundColor({ tabId, color: changed ? "#fb4" : "#f06" }).catch(() => {})
  await chrome.action.setBadgeTextColor?.({ tabId, color: changed ? "#000" : "#fff" })?.catch(() => {})
  await chrome.action.setTitle({ tabId, title: changed ? "Agent Socket: your link changed. Click to copy the new one." : "Agent Socket" }).catch(() => {})
}

// Indicator updates run one at a time, and a show re-checks the binding when
// its turn comes: otherwise a show started by a page load can land after
// Stop's hide and leave "AI" on a tab that is no longer connected.
let indicatorQueue = Promise.resolve()
function queueIndicator(fn) {
  indicatorQueue = indicatorQueue.then(fn, fn)
  return indicatorQueue
}

function showIndicator(tabId) {
  return queueIndicator(async () => {
    if (tabId !== boundTabId) return
    await updateBadge(tabId)
    await chrome.scripting.executeScript({ target: { tabId }, files: ["pill.js"] }).catch(() => {})
  })
}

function hideIndicator(tabId) {
  return queueIndicator(async () => {
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {})
    await chrome.action.setTitle({ tabId, title: "Agent Socket" }).catch(() => {})
    await chrome.tabs.sendMessage(tabId, { type: "as_pill_remove" }).catch(() => {})
  })
}

async function markLinkChanged(info) {
  linkChanged = { at: Date.now(), ...info }
  lastToolCallAt = null  // that activity was on the dead link
  const tabId = boundTabId
  if (tabId != null) await queueIndicator(() => tabId === boundTabId ? updateBadge(tabId) : undefined)
}

// The user copied the new link (`via` popup / pill) or the AI used it (tool_call).
async function clearLinkChanged(via) {
  if (!linkChanged) return
  linkChanged = null
  logEvent("link_acknowledged", { via })
  const tabId = boundTabId
  if (tabId != null) await queueIndicator(() => tabId === boundTabId ? updateBadge(tabId) : undefined)
  await saveSession()
}

// Navigations reset per-tab badges and drop the pill; put both back.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== boundTabId) return
  if (info.status === "complete") void showIndicator(tabId)
  if (info.url || info.status === "complete") scheduleToolSwap()
})

// ── tools follow the tab across allowed sites ──────────────────────
// Once the tab settles on an allowed site other than the one whose tools are
// loaded, load that site's registry profile (+ kept local profile) on the
// same link. A paused tab keeps the loaded tools.
let swapTimer = null
function scheduleToolSwap(delay = 500) {
  clearTimeout(swapTimer)
  swapTimer = setTimeout(() => void swapTools().catch((e) => console.warn("[as-ext] tool swap failed:", e?.message ?? e)), delay)
}

async function swapTools() {
  const s = session
  const tab = s && boundTabId != null ? await chrome.tabs.get(boundTabId).catch(() => null) : null
  if (!tab || !originAllowed(tab.url, lock())) return
  const host = hostOf(tab.url), hostname = hostnameOf(tab.url)
  if (!host || host === toolsHost) return
  const base = await getRegistryBase()
  const registry = lastRegistry?.hostname === hostname && lastRegistry.base === base
    ? lastRegistry
    : { ...(await fetchSiteProfile(base, hostname)), hostname, base }
  if (s !== session) return
  logEvent("tools_swapped", { host })
  await refreshLiveTools(5000, host, registry)
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === boundTabId) void stopConnect()
})

// ── surviving a service-worker restart ─────────────────────────────
// Chrome can stop this worker (and its WebSocket) at any time. The live
// session is saved in chrome.storage.session (memory only, cleared when Chrome
// exits; not readable by content scripts), so a restarted worker can resume
// it: the relay holds a dropped session (24 h on agentsocket.dev), and with
// the resume secret the SAME agent URL keeps working. If the relay can't be
// reached yet (laptop just woke, network down), the saved session is kept and
// retried with backoff, here and on every later worker start, until the relay
// answers: it then resumes, or refuses and a new link is made.
const SAVED_KEY = "as_session"  // { tabId, base, sessionId, secret, url, token, registry, linkChanged, endsAt, allowedOrigins, anyOrigin, toolsHost }
let resumeRetry = null     // { timer, attempt }: pending retry of a saved session's resume

async function saveSession() {
  const tabId = boundTabId
  if (tabId == null) return
  const limits = { endsAt, allowedOrigins, anyOrigin, toolsHost }
  if (!session) {
    // Still waiting to resume: keep the saved session, with the user's latest timer and sites.
    const saved = (await chrome.storage.session.get(SAVED_KEY).catch(() => ({})))[SAVED_KEY]
    if (saved?.tabId === tabId && boundTabId === tabId) await chrome.storage.session.set({ [SAVED_KEY]: { ...saved, ...limits } }).catch(() => {})
    return
  }
  await chrome.storage.session.set({
    [SAVED_KEY]: {
      tabId,
      base: lastBase,
      sessionId: session.sessionId,
      secret: session.resumeSecret,
      url: lastUrl,
      token: lastToken,
      registry: lastRegistry,
      linkChanged,
      ...limits,
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
  allowedOrigins = saved.allowedOrigins ?? [originOf(tab.url)].filter(Boolean)
  anyOrigin = !!saved.anyOrigin
  toolsHost = saved.toolsHost ?? null
  setDeadline(saved.endsAt ?? null)
  // The timer ran out while the worker was stopped: end the held session.
  if (expired()) return void stopConnect("expired")
  emitStatus({ status: "connecting" })
  // Don't await: a slow resume mustn't hold up every message handler.
  startConnect(tab.id, saved).catch((e) => console.warn("[as-ext] resume after restart failed:", e?.message ?? e))
})().catch(() => {})

// ── connection lifecycle ──────────────────────────────────────────

function startConnect(tabId, saved) {
  connecting ??= doConnect(tabId, saved).finally(() => { connecting = null })
  return connecting
}

function cancelResumeRetry() {
  if (resumeRetry) clearTimeout(resumeRetry.timer)
  resumeRetry = null
}

// Failures that retrying can't fix. Anything else (the socket didn't open,
// dropped, or timed out before the relay answered) is the network or the relay.
function isPermanent(e) {
  return /^(no tab to bind|connect cancelled|site access not granted|register failed)/.test(e?.message ?? "")
}

// Retry a saved session's resume, backing off to 30 s between attempts.
function scheduleResumeRetry(tabId, saved) {
  const attempt = (resumeRetry?.attempt ?? 0) + 1
  const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5)
  if (resumeRetry) clearTimeout(resumeRetry.timer)
  resumeRetry = {
    attempt,
    timer: setTimeout(() => {
      if (boundTabId !== tabId || session) return
      startConnect(tabId, saved).catch(() => {})
    }, delay),
  }
}

// `saved`: a session from before a worker restart, to resume rather than start.
async function doConnect(tabId, saved) {
  if (!saved) cancelResumeRetry()
  const tab = tabId != null
    ? await chrome.tabs.get(tabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (!tab) throw new Error("no tab to bind")
  if (session) {
    if (tab.id === boundTabId && session.connected) {
      return { status: "already_connected", url: lastUrl, host: hostOf(tab.url), profile: lastRegistry?.profile?.host ?? null, source: lastSource }
    }
    await stopConnect()
  }
  if (!(await chrome.permissions.contains(SITE_ACCESS))) {
    throw new Error("site access not granted — click Connect in the extension popup to allow it")
  }
  const settings = await chrome.storage.local.get(["relay_base", "session_minutes", "default_any_site", "test_session_ms"])
  const base = settings.relay_base || DEFAULT_BASE
  const resume = saved && saved.base === base ? { sessionId: saved.sessionId, secret: saved.secret } : undefined
  lastBase = base

  boundTabId = tab.id
  lastToolCallAt = null
  // A new session's timer counts from Connect and it is locked to this tab's
  // origin. (A saved one's were restored with it.) `test_session_ms`: a short
  // deadline for the e2e tests, settable only from devtools.
  if (!saved) {
    setDeadline(settings.test_session_ms > 0 ? Date.now() + settings.test_session_ms : deadlineFor(sessionMinutes(settings.session_minutes), Date.now()))
    allowedOrigins = [originOf(tab.url)].filter(Boolean)
    anyOrigin = settings.default_any_site === true
  }
  // While resuming a saved session, its link (and any unacknowledged change)
  // stays on show: the relay is holding it.
  linkChanged = saved?.linkChanged ?? null
  if (saved?.url) { lastUrl = saved.url; lastToken = saved.token }
  // Tools for the tab's site; a resumed session that is paused keeps the ones it had.
  const host = !originAllowed(tab.url, lock()) && toolsHost ? toolsHost : hostOf(tab.url)
  emitStatus({ status: resumeRetry ? "reconnect-failed" : "connecting" })

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
    if (boundTabId !== tab.id) throw new Error("connect cancelled")
    toolSet = await computeToolSet(host, registry)
    const { tools, agentsMd } = toolSet
    s = await connect({
      baseUrl: base,
      appId: "as_app_anon",
      appDescription: `Chrome extension driving one browser tab on ${host || "unknown host"}.`,
      agentsMd,
      tools,
      onDisconnect: (info) => {
        if (session && s !== session) return info.giveUp()
        // attempt 1 = the WS just dropped; later = a reconnect attempt failed.
        logEvent(info.attempt === 1 ? "drop" : "retry_failed", { code: info.code, reason: info.reason, attempt: info.attempt })
        emitStatus({ status: info.attempt === 1 ? "disconnected" : "reconnect-failed", reason: info.reason, attempt: info.attempt })
        reconnectBackoff(info)
      },
      // The usual reconnect resumes the same session: the URL is unchanged.
      onReconnect: ({ sessionId, resumed }) => {
        if (s !== session || !resumed) return
        logEvent("resumed", { sessionId })
        emitStatus({ status: "connected", sessionId })
        void saveSession()
      },
      // The resume was refused, so the SDK opened a new session and re-minted
      // our token; pick up the new URL + token (or mint one if that failed),
      // and tell the user: the link they gave the AI is dead.
      onSessionChanged: async ({ priorSessionId, sessionId, tokensRemapped, reason, closeCode, offlineMs }) => {
        if (s !== session) return
        if (sessionId !== priorSessionId) {
          logEvent(reason === "replaced" ? "replaced" : reason === "no_resume_secret" ? "no_resume" : "resume_refused", { code: closeCode, sessionId: priorSessionId, offlineMs })
          logEvent("new_session", { sessionId })
        } else {
          logEvent("reminted", { sessionId })
        }
        const priorUrl = lastUrl
        try {
          const fresh = tokensRemapped.get(lastUrl)
          const link = fresh
            ? (await s.listAgentTokens()).find((t) => t.url === fresh)
            : await s.mintAgentToken({ label: "chrome-extension" })
          lastUrl = link?.url ?? null
          lastToken = link?.token ?? null
        } catch { lastUrl = lastToken = null }
        if (priorUrl && lastUrl !== priorUrl) await markLinkChanged({ reason: reason ?? "resume_refused", closeCode, offlineMs })
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
    if (resume && s.sessionId === resume.sessionId) logEvent("resumed", { sessionId: s.sessionId, afterRestart: true })
    else if (resume) {
      // connect() falls back to a fresh session only when the relay refuses (4401).
      logEvent("resume_refused", { code: 4401, sessionId: resume.sessionId, afterRestart: true })
      logEvent("new_session", { sessionId: s.sessionId })
    } else logEvent("connected", { sessionId: s.sessionId })
    // After a worker restart: the user already had saved.url. Same link →
    // carry over a change they haven't acknowledged; a new one → it changed.
    if (saved?.url) {
      linkChanged = kept ? saved.linkChanged ?? null
        : !resume ? { at: Date.now(), reason: "relay_changed", afterRestart: true }
        : s.sessionId === resume.sessionId ? { at: Date.now(), reason: "link_missing", afterRestart: true }
        : { at: Date.now(), reason: "resume_refused", closeCode: 4401, afterRestart: true }
    }
    session = s
    lastUrl = link.url
    lastToken = link.token
    lastRegistry = registry
    lastSource = toolSet.source
    lastToolsKey = toolSet.key
    toolsHost = host
  } catch (e) {
    s?.close()
    logEvent("connect_failed", { reason: e?.message ?? String(e) })
    if (saved && boundTabId === tab.id && !isPermanent(e)) {
      // Can't reach the relay yet. Keep the saved session (and the pill, now
      // "reconnecting…") and try again.
      scheduleResumeRetry(tab.id, saved)
      logEvent("resume_retry", { reason: e?.message ?? String(e), attempt: resumeRetry.attempt })
      emitStatus({ status: "reconnect-failed", reason: e?.message ?? String(e), attempt: resumeRetry.attempt })
      void showIndicator(tab.id)
      throw e
    }
    if (boundTabId === tab.id) {
      lastUrl = lastToken = null
      resetLimits()
      boundTabId = null; void hideIndicator(tab.id)
      await chrome.storage.session.remove(SAVED_KEY).catch(() => {})
    }
    emitStatus({ status: "closed", reason: e?.message ?? String(e) })
    throw e
  }
  cancelResumeRetry()
  await saveSession()
  emitStatus({ status: "connected", sessionId: session.sessionId })
  await showIndicator(tab.id)
  // A Keep or delete, or the tab moving to another site, while we were
  // connecting: pick it up (no-op otherwise).
  void refreshLiveTools().catch(() => {})
  scheduleToolSwap(0)
  return { status: "connected", url: lastUrl, host, profile: registry.profile?.host ?? null, source: toolSet.source, tool_count: toolSet.tools.length }
}

// `why`: "stopped" (the user, a closed tab, another Connect) or "expired" (the timer).
async function stopConnect(why = "stopped") {
  cancelResumeRetry()
  const s = session, token = lastToken, tabId = boundTabId
  // Reset synchronously: a connect in flight checks boundTabId after each await.
  session = null
  lastUrl = lastToken = lastToolCallAt = null
  lastRegistry = lastSource = lastToolsKey = null
  linkChanged = null
  boundTabId = null
  resetLimits()
  if (s || (why === "expired" && tabId != null)) logEvent(why)
  emitStatus(why === "expired" ? { status: "closed", reason: "the session timer ran out" } : { status: "idle" })
  // Stopped while still waiting to resume a saved session: the relay is
  // holding it, so end it there too.
  const held = !s && tabId != null ? (await chrome.storage.session.get(SAVED_KEY).catch(() => ({})))[SAVED_KEY] : null
  await chrome.storage.session.remove(SAVED_KEY).catch(() => {})
  if (s) {
    // close() ends the session on the relay, killing every token; revoke first anyway.
    if (token && s.connected) await Promise.race([s.revokeAgentToken(token).catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
    s.close()
  } else if (held?.secret && held.sessionId) {
    void endSession({ baseUrl: held.base, sessionId: held.sessionId, secret: held.secret })
  }
  if (tabId != null) await hideIndicator(tabId)
  return { status: "idle" }
}

function emitStatus(s) { lastStatus = s }

function hostOf(url) { try { return new URL(url).host } catch { return "" } }
function hostnameOf(url) { try { return new URL(url).hostname } catch { return "" } }

async function snapshot() {
  const tab = boundTabId != null ? await chrome.tabs.get(boundTabId).catch(() => null) : null
  return {
    status: lastStatus,
    url: lastUrl,
    connected: session?.connected ?? false,
    boundTab: tab && { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl },
    profileHost: lastRegistry?.profile?.host ?? null,
    source: session ? lastSource : null,
    sourceLabel: session ? sourceLabel(lastSource) : "",
    lastToolCallAt,
    linkChanged,
    endsAt,
    siteLock: { origins: allowedOrigins, any: anyOrigin },
    paused: tab ? pauseInfo(tab.url) : null,
    events: events.slice(-10),
  }
}

// Our own pages (the popup) vs content scripts (the pill, in the bound tab's top frame).
const fromPopup = (sender) => sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""))
const fromPillOrPopup = (sender) => fromPopup(sender) || (sender.tab?.id != null && sender.tab.id === boundTabId && sender.frameId === 0)

// ── popup + pill messaging ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      await restored
      if (msg?.type === "connect") sendResponse({ ok: true, ...(await startConnect(msg.tabId)) })
      else if (msg?.type === "disconnect") sendResponse({ ok: true, ...(await stopConnect()) })
      else if (msg?.type === "snapshot") sendResponse({ ok: true, ...(await snapshot()) })
      else if (msg?.type === "pill_state") {
        const bound = sender.tab?.id != null && sender.tab.id === boundTabId
        const left = bound ? timeLeft(endsAt, Date.now()) : null
        sendResponse({
          bound, status: lastStatus.status, lastToolCallAt, linkChanged: !!linkChanged,
          left: left == null ? null : shortLeft(left), soon: left != null && left < 60_000,
          paused: bound ? pauseInfo(sender.tab.url) : null,
        })
      } else if (msg?.type === "set_timer") {
        // A new length from now (popup Change), or 0: no limit (Remove timer).
        if (!fromPopup(sender) || boundTabId == null) throw new Error("not connected")
        const minutes = Number(msg.minutes)
        if (minutes !== 0 && !TIMER_CHOICES.includes(minutes)) throw new Error(`timer must be one of ${TIMER_CHOICES.join(", ")} minutes, or 0`)
        setDeadline(deadlineFor(minutes, Date.now()))
        logEvent("timer_set", { minutes })
        await saveSession()
        sendResponse({ ok: true, endsAt })
      } else if (msg?.type === "allow_origin") {
        // "Allow <host>": adds the origin the tab is on now, which must be the
        // one the button showed.
        if (!fromPillOrPopup(sender) || boundTabId == null) throw new Error("not connected")
        const tab = await chrome.tabs.get(boundTabId).catch(() => null)
        const origin = originOf(tab?.url)
        if (!origin || origin !== msg.origin) throw new Error("the tab is no longer on that site")
        if (!allowedOrigins.includes(origin)) allowedOrigins = [...allowedOrigins, origin]
        logEvent("origin_allowed", { host: originLabel(origin) })
        await saveSession()
        scheduleToolSwap(0)
        sendResponse({ ok: true })
      } else if (msg?.type === "remove_origin") {
        if (!fromPopup(sender) || boundTabId == null) throw new Error("not connected")
        allowedOrigins = allowedOrigins.filter((o) => o !== msg.origin)
        await saveSession()
        sendResponse({ ok: true })
      } else if (msg?.type === "set_any_origin") {
        if (!fromPopup(sender) || boundTabId == null) throw new Error("not connected")
        anyOrigin = msg.any === true
        logEvent("any_origin", { on: anyOrigin })
        await saveSession()
        scheduleToolSwap(0)
        sendResponse({ ok: true })
      } else if (msg?.type === "pill_link") {
        // Only to the pill in the bound tab's top frame (our content script;
        // page scripts can't message the extension). It never enters the DOM.
        const ok = sender.tab?.id != null && sender.tab.id === boundTabId && sender.frameId === 0 && !!lastUrl
        sendResponse(ok ? { ok: true, url: lastUrl } : { ok: false })
      } else if (msg?.type === "ack_link") {
        await clearLinkChanged(msg.via === "pill" ? "pill" : "popup")
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
        sendResponse({ ok: true, ...(await refreshLiveTools()) })
      } else if (msg?.type === "discard_profile") {
        await withProfiles((d) => { delete d.pending[msg.host] })
        sendResponse({ ok: true })
      } else if (msg?.type === "delete_profile") {
        await withProfiles((d) => { delete d.kept[msg.host] })
        sendResponse({ ok: true, ...(await refreshLiveTools()) })
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
// run through the SW, keeping it (and therefore the WebSocket) alive.
//
// Chrome MV3 clamps periodInMinutes to a minimum of 0.5 (30s). The relay's
// HEARTBEAT_TIMEOUT_MS is 50s, so a 30s alarm keeps the connection alive.
chrome.alarms.create("as-keepalive", { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "as-keepalive" && session?.connected) session.ping()
  if (a.name === TIMER_ALARM) {
    void restored.then(() => {
      if (endsAt == null) return
      if (Date.now() >= endsAt - 1000) void stopConnect("expired")
      else setDeadline(endsAt)  // fired early: re-arm
    })
  }
})
