// Popup controller. Talks to background via chrome.runtime.sendMessage.

const $ = (s) => document.querySelector(s)
const statusDot = $("#status-dot")
const statusText = $("#status-text")
const tabHost = $("#tab-host")
const profileName = $("#profile-name")
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
const openExtDetailsBtn = $("#open-ext-details")
const recheckUserScriptsBtn = $("#recheck-user-scripts")
const keybindsList = $("#keybinds-list")
const openShortcutsBtn = $("#open-shortcuts")

function setStatus(s) {
  const code = s?.status ?? "idle"
  statusDot.dataset.status = code
  statusText.textContent = code + (s?.code ? ` (${s.code})` : "")
}

function setError(msg) {
  errorMsg.textContent = msg || ""
}

async function activeTabHost() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
  try { return new URL(t.url).host } catch { return t?.url ?? "—" }
}

async function refresh() {
  const snap = await chrome.runtime.sendMessage({ type: "snapshot" })
  if (!snap?.ok) return
  setStatus(snap.status)
  tabHost.textContent = await activeTabHost()
  profileName.textContent = snap.profileHost ?? "—"
  if (snap.connected && snap.url) {
    linkCard.hidden = false
    linkInput.value = snap.url
    connectBtn.hidden = true
    disconnectBtn.hidden = false
  } else {
    linkCard.hidden = true
    connectBtn.hidden = false
    disconnectBtn.hidden = true
  }
  // Profiles list
  const list = await chrome.runtime.sendMessage({ type: "list_profiles" })
  profilesList.innerHTML = ""
  if (list?.ok) {
    for (const h of list.saved) {
      const li = document.createElement("li")
      li.textContent = h + " "
      const x = document.createElement("a")
      x.href = "#"; x.textContent = "delete"; x.style.color = "var(--err)"
      x.addEventListener("click", async (e) => {
        e.preventDefault()
        await chrome.runtime.sendMessage({ type: "delete_profile", host: h })
        refresh()
      })
      li.appendChild(x)
      profilesList.appendChild(li)
    }
  }
  // Relay
  const stored = await chrome.storage.local.get("relay_base")
  relayInput.value = stored.relay_base ?? ""

  // userScripts toggle status — banner appears if disabled.
  const us = await chrome.runtime.sendMessage({ type: "check_user_scripts" })
  if (us?.ok && !us.available) {
    userScriptsWarn.hidden = false
  } else {
    userScriptsWarn.hidden = true
  }

  // Keybinds — read-only display. Agents own this via /configure_keybind.
  const kb = await chrome.runtime.sendMessage({ type: "get_keybinds" })
  if (kb?.ok) {
    keybindsList.innerHTML = ""
    for (let n = 1; n <= 4; n++) {
      const url = kb.slots?.[String(n)] ?? ""
      const cmd = (kb.commands ?? []).find((c) => c.name === `connect-slot-${n}`)
      const key = cmd?.shortcut || ""
      const li = document.createElement("li")
      const slot = document.createElement("span")
      slot.className = "kb-slot"
      slot.textContent = `${n}.`
      const keyEl = document.createElement("span")
      keyEl.className = "kb-key" + (key ? "" : " unset")
      keyEl.textContent = key || "no key"
      const urlEl = document.createElement("span")
      urlEl.className = "kb-url" + (url ? "" : " unset")
      urlEl.textContent = url || "unconfigured"
      urlEl.title = url
      li.appendChild(slot)
      li.appendChild(keyEl)
      li.appendChild(urlEl)
      keybindsList.appendChild(li)
    }
  }
}

openShortcutsBtn?.addEventListener("click", async (e) => {
  e.preventDefault()
  await chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
})

openExtDetailsBtn?.addEventListener("click", async () => {
  // chrome:// URLs can't be opened from a popup directly; create a tab.
  const id = chrome.runtime.id
  await chrome.tabs.create({ url: `chrome://extensions/?id=${id}` })
})

recheckUserScriptsBtn?.addEventListener("click", async () => {
  recheckUserScriptsBtn.disabled = true
  try { await refresh() } finally { recheckUserScriptsBtn.disabled = false }
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
  setStatus({ status: "connecting" })
  connectBtn.disabled = true
  try {
    const res = await chrome.runtime.sendMessage({ type: "connect" })
    if (!res?.ok) { setError(res?.error ?? "connect failed"); setStatus({ status: "error" }); return }
    setStatus({ status: "connected" })
    linkCard.hidden = false
    linkInput.value = res.url
    connectBtn.hidden = true
    disconnectBtn.hidden = false
    profileName.textContent = res.profile ?? "—"
    const copied = await copyLinkToClipboard()
    if (copied) flashCopied()
    copyHint.textContent = copied
      ? `${res.tool_count} tools registered. Link copied — paste into your AI.`
      : `${res.tool_count} tools registered. Paste this in your AI.`
  } catch (e) {
    setError(e?.message ?? String(e))
    setStatus({ status: "error" })
  } finally {
    connectBtn.disabled = false
  }
})

disconnectBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" })
  refresh()
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "status") setStatus(msg.status)
})

refresh()
