// Activity log page: everything the AI did, from chrome.storage.local (see
// lib/activity.js), grouped by session, newest first. Each entry, a session's
// entries, or all of them can be deleted here. Entries hold text the AI and
// web pages wrote, so it only ever goes in via textContent.

import { LEVELS, createActivityStore, groupBySession, isEntryKey, levelOf, matchesFilter } from "./lib/activity.js"

const $ = (s) => document.querySelector(s)
const groupsEl = $("#groups")
const filterInput = $("#filter")
const countEl = $("#count")
const noteEl = $("#note")
const exportBtn = $("#export")
const deleteAllBtn = $("#delete-all")
const store = createActivityStore(chrome.storage.local)

let entries = []
const open = new Set()  // ids of expanded entries

function el(tag, attrs, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === "text") n.textContent = v
    else n.setAttribute(k, v)
  }
  for (const c of children) if (c != null) n.append(c)
  return n
}

const statusClass = (st) => (st < 300 ? "ok" : st < 500 ? "warn" : "err")
const time = (at) => new Date(at).toLocaleTimeString()
const dateTime = (at) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
const duration = (ms) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
const ENDINGS = { stopped: "stopped", expired: "timer ran out", tab_closed: "tab closed" }

async function load() {
  entries = await store.list()
  const { activity_level } = await chrome.storage.local.get("activity_level")
  noteEl.textContent = `Stored only on this computer for 7 days. Detail level: ${LEVELS[levelOf(activity_level)]}; change it in the extension's Settings.`
  render()
}

function entryNode(e) {
  const isCall = e.kind === "call"
  const del = el("button", { class: "del", title: "Delete this entry", "data-action": "delete", text: "×" })
  del.addEventListener("click", async (ev) => {
    ev.stopPropagation()
    await store.remove(e.id)
  })
  const row = el("div", { class: "row" },
    el("span", { class: "when", text: time(e.at) }),
    el("span", { class: "host", title: e.host ?? "", text: e.host || "" }),
    el("span", { class: "tool", text: isCall ? e.tool : "session" }),
    el("span", { class: "summary", title: [e.summary, e.message].filter(Boolean).join("\n") },
      e.summary ?? "", e.error ? el("span", { class: "err-code", text: ` · ${e.error}` }) : null),
    isCall ? el("span", { class: `st ${statusClass(e.status)}`, title: e.error ?? "", text: String(e.status) }) : el("span"),
    el("span", { class: "ms", text: isCall ? duration(e.ms) : "" }),
    del)
  const node = el("div", { class: `entry ${isCall ? "call" : "session"}`, "data-id": e.id }, row)
  if (open.has(e.id)) node.append(detailNode(e))
  row.addEventListener("click", () => {
    if (open.has(e.id)) { open.delete(e.id); node.querySelector("pre")?.remove() }
    else { open.add(e.id); node.append(detailNode(e)) }
  })
  return node
}

function detailNode(e) {
  const { id, kind, summary, ...rest } = e
  const shown = Object.fromEntries(Object.entries({ ...rest, at: new Date(e.at).toISOString() }).filter(([, v]) => v != null))
  return el("pre", { class: "detail", text: JSON.stringify(shown, null, 2) })
}

function groupNode(g) {
  const del = el("button", { class: "ghost small", "data-action": "delete-session", text: "Delete session" })
  del.addEventListener("click", () => store.remove(g.entries.map((e) => e.id)))
  const calls = g.entries.filter((e) => e.kind === "call").length
  const end = g.ending ? ` · ${ENDINGS[g.ending] ?? g.ending} ${time(g.end)}` : ""
  const head = el("div", { class: "group-head" },
    el("span", { class: "title" },
      el("span", { class: "host", text: g.host || "unknown site" }),
      el("span", { class: "muted", text: ` · ${dateTime(g.start)}${end} · ${calls} action${calls === 1 ? "" : "s"}` }),
      g.session ? el("span", { class: "muted small", text: ` · session ${g.session}` }) : null),
    del)
  return el("section", { class: "group", "data-session": g.session ?? "" }, head, ...g.entries.map(entryNode))
}

function render() {
  const q = filterInput.value
  const shown = entries.filter((e) => matchesFilter(e, q))
  countEl.textContent = q ? `${shown.length} of ${entries.length}` : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`
  deleteAllBtn.disabled = exportBtn.disabled = !entries.length
  groupsEl.replaceChildren(...(shown.length
    ? groupBySession(shown).map(groupNode)
    : [el("p", { class: "muted empty", text: entries.length ? "Nothing matches the filter." : "No activity yet. Actions the AI takes in a connected tab show up here." })]))
}

filterInput.addEventListener("input", render)

deleteAllBtn.addEventListener("click", async () => {
  if (!confirm(`Delete all ${entries.length} activity entries? This can't be undone.`)) return
  await store.clear()
})

exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" })
  const a = el("a", { href: URL.createObjectURL(blob), download: `agent-socket-activity-${new Date().toISOString().slice(0, 10)}.json` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

// New calls, deletions (here or in another tab) and setting changes.
let reload = null
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some((k) => isEntryKey(k) || k === "activity_level")) return
  clearTimeout(reload)
  reload = setTimeout(load, 150)
})

load()
