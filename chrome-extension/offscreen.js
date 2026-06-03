// Offscreen document: clipboard writes for the service worker.
//
// MV3 service workers can't touch navigator.clipboard. The supported path is
// a hidden DOM document hosted by chrome.offscreen, which we message into
// with the text we want to copy.

const sink = document.getElementById("sink")

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.__as_target !== "offscreen") return false
  if (msg.type !== "copy") return false
  ;(async () => {
    let ok = false
    let err = null
    try {
      // execCommand is the reliable path for offscreen — navigator.clipboard
      // refuses without document focus and there's no UA gesture here.
      sink.value = msg.text ?? ""
      sink.focus()
      sink.select()
      ok = document.execCommand("copy")
    } catch (e) {
      err = e?.message ?? String(e)
    }
    if (!ok) {
      try {
        await navigator.clipboard.writeText(msg.text ?? "")
        ok = true
      } catch (e) { err = err ?? (e?.message ?? String(e)) }
    }
    sendResponse({ ok, error: ok ? null : err })
  })()
  return true
})
