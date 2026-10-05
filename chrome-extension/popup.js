// Popup controller. Talks to background via chrome.runtime.sendMessage and
// polls its snapshot once a second while open.

const $ = (s) => document.querySelector(s)
const statusDot = $("#status-dot")
const statusText = $("#status-text")
const tabLabel = $("#tab-label")
const tabRow = $("#tab-row")
const tabIcon = $("#tab-icon")
const tabTitle = $("#tab-title")
const tabHost = $("#tab-host")
const connectBtn = $("#connect-btn")
const disconnectBtn = $("#disconnect-btn")
const linkCard = $("#link-card")
const linkInput = $("#link-input")
const copyBtn = $("#copy-btn")
const copyHint = $("#copy-hint")
const relayInput = $("#relay-input")
const saveRelay = $("#save-relay")
const profilesList = $("#profiles-list")
const errorMsg = $("#error-msg")
const userScriptsWarn = $("#user-scripts-warn")
const userScriptsHint = $("#user-scripts-hint")
const openExtDetailsBtn = $("#open-ext-details")
const recheckUserScriptsBtn = $("#recheck-user-scripts")

let shownTab = null  // { id, windowId } of the tab the card shows

const ago = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`)

function statusLabel(snap) {
  switch (snap.status?.status) {
    case "connecting": return "Connecting…"
    case "connected":
      return snap.lastToolCallAt ? `AI active — last tool call ${ago(Date.now() - snap.lastToolCallAt)} ago` : "Connected — waiting for AI"
    case "disconnected":
    case "reconnect-failed": return "Reconnecting…"
    case "closed": return `Disconnected${snap.status.reason ? ` (${snap.status.reason})` : ""}`
    default: return "Not connected"
  }
}

function setError(msg) {
  errorMsg.textContent = msg || ""
}

function showTab(tab, bound) {
  shownTab = tab ? { id: tab.id, windowId: tab.windowId } : null
  tabLabel.textContent = bound ? "Connected tab" : "This tab"
  tabTitle.textContent = tab?.title || "Current tab"
  let host = ""
  try { host = new URL(tab.url).host } catch {}
  tabHost.textContent = host
  tabIcon.hidden = !tab?.favIconUrl
  if (tab?.favIconUrl) tabIcon.src = tab.favIconUrl
}

async function render() {
  const snap = await chrome.runtime.sendMessage({ type: "snapshot" })
  if (!snap?.ok) return
  const code = snap.status?.status ?? "idle"
  statusDot.dataset.status = code === "connected" && snap.lastToolCallAt ? "active" : code
  statusText.textContent = statusLabel(snap)
  if (snap.boundTab) showTab(snap.boundTab, true)
  else showTab((await chrome.tabs.query({ active: true, currentWindow: true }))[0], false)
  const bound = !!snap.boundTab
  connectBtn.hidden = bound
  disconnectBtn.hidden = !bound
  linkCard.hidden = !(bound && snap.url)
  if (snap.url && linkInput.value && linkInput.value !== snap.url) {
    copyHint.textContent = "Link refreshed after a reconnect — re-paste it in your AI."
  }
  linkInput.value = snap.url ?? ""
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("relay_base")
  relayInput.value = stored.relay_base ?? ""
  const list = await chrome.runtime.sendMessage({ type: "list_profiles" })
  profilesList.innerHTML = ""
  for (const h of list?.saved ?? []) {
    const li = document.createElement("li")
    li.textContent = h + " "
    const x = document.createElement("a")
    x.href = "#"; x.textContent = "delete"; x.style.color = "var(--err)"
    x.addEventListener("click", async (e) => {
      e.preventDefault()
      await chrome.runtime.sendMessage({ type: "delete_profile", host: h })
      loadSettings()
    })
    li.appendChild(x)
    profilesList.appendChild(li)
  }
}

async function checkUserScripts() {
  const us = await chrome.runtime.sendMessage({ type: "check_user_scripts" })
  userScriptsWarn.hidden = !us?.ok || us.available
  const major = Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? 0)
  userScriptsHint.textContent = major >= 138
    ? "The AI's /eval needs user scripts on sites like x.com, Google, GitHub. Open the extension's details page and turn on \"Allow User Scripts\"."
    : major >= 135
      ? "The AI's /eval needs user scripts on sites like x.com, Google, GitHub. Turn on \"Developer mode\" at the top right of chrome://extensions."
      : "The AI's /eval needs chrome.userScripts on CSP-strict sites, which requires Chrome 135 or newer."
}

tabRow.addEventListener("click", async () => {
  if (!shownTab) return
  await chrome.tabs.update(shownTab.id, { active: true }).catch(() => {})
  await chrome.windows.update(shownTab.windowId, { focused: true }).catch(() => {})
})

openExtDetailsBtn.addEventListener("click", async () => {
  // chrome:// URLs can't be opened from a popup directly; create a tab.
  await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
})

recheckUserScriptsBtn.addEventListener("click", async () => {
  recheckUserScriptsBtn.disabled = true
  try { await checkUserScripts() } finally { recheckUserScriptsBtn.disabled = false }
})

async function copyLinkToClipboard() {
  try {
    await navigator.clipboard.writeText(linkInput.value)
    return true
  } catch {
    linkInput.select()
    return document.execCommand("copy")
  }
}

function flashCopied() {
  copyBtn.textContent = "Copied!"
  setTimeout(() => (copyBtn.textContent = "Copy"), 1500)
}

connectBtn.addEventListener("click", async () => {
  setError("")
  connectBtn.disabled = true
  try {
    // Site access is optional and asked for here, on the user's click.
    if (!(await chrome.permissions.request({ origins: ["<all_urls>"] }))) {
      setError("Agent Socket needs site access to drive the tab.")
      return
    }
    statusText.textContent = "Connecting…"
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const res = await chrome.runtime.sendMessage({ type: "connect", tabId: tab?.id })
    if (!res?.ok) { setError(res?.error ?? "connect failed"); return }
    await render()
    const copied = await copyLinkToClipboard()
    if (copied) flashCopied()
    copyHint.textContent = (copied ? "Link copied — paste it into your AI. " : "Paste this into your AI. ") +
      "Anyone with it can drive this tab until you stop."
  } catch (e) {
    setError(e?.message ?? String(e))
  } finally {
    connectBtn.disabled = false
  }
})

disconnectBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" })
  render()
})

copyBtn.addEventListener("click", async () => {
  await copyLinkToClipboard()
  flashCopied()
})

saveRelay.addEventListener("click", async () => {
  const v = relayInput.value.trim() || ""
  await chrome.runtime.sendMessage({ type: "set_relay_base", base: v })
  saveRelay.textContent = "Saved"
  setTimeout(() => (saveRelay.textContent = "Save"), 1500)
})

render()
loadSettings()
checkUserScripts()
setInterval(render, 1000)
