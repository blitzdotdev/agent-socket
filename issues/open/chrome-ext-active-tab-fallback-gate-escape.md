# chrome-ext: `getActiveTabId` silently retargets to the user's CURRENT tab when the bound tab dies — defeats the per-tab activation gate

## What's wrong

`getActiveTabId` (`chrome-extension/background.js:38-50`) falls back to whatever tab the user is currently looking at when the bound tab is gone:

```js
async function getActiveTabId() {
  if (boundTabId != null) {
    try {
      const t = await chrome.tabs.get(boundTabId)
      if (t) return t.id
    } catch { /* tab gone */ }     // swallowed
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null            // ← the user's CURRENT tab
}
```

Every privileged tool (`/eval`, `/click`, `/fill`, `/navigate`, `/get_text`, `/screenshot`, …) routes its target through `getActiveTabId`. When the bound tab is closed (or its id is reused/garbage), `chrome.tabs.get(boundTabId)` throws, the `catch {}` swallows it, and control falls through to `chrome.tabs.query({ active: true, currentWindow: true })`.

## Why it matters

The extension's entire safety premise is the **per-tab activation gate**: the AI is supposed to be confined to the one tab the user explicitly bound via "Connect this tab." This fallback collapses that to "whatever tab is focused." Concretely:

- The agent has a session bound to tab X (e.g. a keybind-opened background tab). Tab X closes.
- The remote AI issues any tool call.
- The tool now executes in the page the user is **currently looking at** — their banking tab, email, an internal admin panel — with full MAIN-world `/eval`, no re-consent, no notification, no host check.

A remote AI gets privileged execution on an arbitrary user page simply by waiting for the bound tab to close (or navigating it away). The comment even frames this as a feature ("keeps long-running agent sessions stable even if the user clicks around"), which is exactly the dangerous behavior.

## What to do

- If `boundTabId` is set but the tab is gone, **fail the tool call** (return an error like `bound_tab_closed`). Never silently substitute the active tab.
- Only use the "active tab" path during the explicit initial bind (the popup "Connect this tab" flow), never for subsequent tool dispatch on an already-bound session.
- Surface "bound tab closed — reconnect to choose a new tab" to the user/agent.

## Acceptance

- After the bound tab is closed, the next tool call returns an error and does NOT execute against the user's current tab.
- Binding still works normally; tool calls against a live bound tab are unaffected.

## Provenance

Found during a full line-by-line audit. Verified `getActiveTabId` (`background.js:38-50`): the `catch {}` on the dead-bound-tab path falls through to `chrome.tabs.query({active:true})`, and all tool handlers resolve their target tab through it. Severity CRITICAL — it is a direct escape of the activation gate that is the extension's primary containment.
