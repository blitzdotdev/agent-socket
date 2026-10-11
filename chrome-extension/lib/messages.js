// Who may send which runtime message to the background worker.
//
// Two kinds of sender exist (web pages can't message the extension: there is
// no externally_connectable): our own pages (popup.html, activity.html; their
// sender.url is on the extension's origin, even when opened as a tab), and the
// pill, our content script in a connected tab's top frame (sender.url is the
// page's address, sender.tab is set). Content scripts run next to page code
// that can't call chrome.runtime itself, but anything a page can make the pill
// do must stay limited to that tab's own session.

// The shape of the background's "snapshot" reply; bump it whenever that shape
// changes. The popup always loads from disk, but Chrome keeps running the
// background worker it loaded (even across worker restarts) until the
// extension is reloaded. So once the folder is updated, a new popup can be
// talking to an old worker: it compares this number to tell, and asks for a
// reload instead of drawing half a page from a reply it doesn't understand.
export const SNAPSHOT_VERSION = 2

// "popup": our pages only. "pill": the pill only. "either": both (the pill
// acts on its own tab, the popup on the tab it names).
export const MESSAGE_SENDERS = {
  connect: "popup",
  disconnect: "either",
  disconnect_all: "popup",
  snapshot: "popup",
  pill_state: "pill",
  set_timer: "popup",
  allow_origin: "either",
  remove_origin: "popup",
  set_any_origin: "popup",
  pill_link: "pill",
  ack_link: "either",
  open_popup: "pill",
  list_profiles: "popup",
  keep_profile: "popup",
  discard_profile: "popup",
  delete_profile: "popup",
  set_registry_base: "popup",
  check_user_scripts: "popup",
  set_relay_base: "popup",
}

// → "popup" | "pill" | null for a runtime.onMessage sender.
export function senderKind(sender, extensionId, extensionUrl) {
  if (!sender || sender.id !== extensionId) return null
  if (typeof sender.url === "string" && sender.url.startsWith(extensionUrl)) return "popup"
  if (sender.tab?.id != null && sender.frameId === 0) return "pill"
  return null
}

// Whether `type` may come from this kind of sender.
export function senderAllowed(type, kind) {
  const rule = MESSAGE_SENDERS[type]
  if (!rule || !kind) return false
  return rule === "either" || rule === kind
}
