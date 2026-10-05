# chrome-ext: console-capture hook is injected into MAIN world of EVERY page load, regardless of any session

## What's wrong

`background.js:446-472` registers a `chrome.tabs.onUpdated` listener unconditionally and injects a MAIN-world console monkey-patch into every tab that reaches `complete`:

```js
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return
  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => { /* override console.* on window, stash window.__as_console */ },
  }).catch(() => {})
})
```

There is no gate on `boundTabId`, on whether a session exists, or on the host. It runs for **every page the user loads**, even when the user has never connected the extension and no AI is attached.

## Why it matters

- **Silent MAIN-world injection into all browsing** under `<all_urls>`: the extension overrides `console.log/info/warn/error/debug` and installs persistent globals (`window.__as_console_hook__`, `window.__as_console`) on every site, all the time.
- **Privacy/overreach**: page console output (which can contain tokens, PII, debug data) is captured into extension-controlled state on every page, with no session and no user intent.
- **Compatibility**: overriding `console.*` is observable to page scripts and can break sites that detect or replace the console, and the override changes serialization semantics.

The capture is only ever needed for a tab the user has explicitly bound, yet it runs everywhere.

## What to do

- Gate the injection on `tabId === boundTabId` (and an active session). Only hook the console of the bound tab.
- Remove the hook / stop capturing when the session ends or the tab is unbound.

## Acceptance

- With no active session, loading pages does not inject the console hook into any tab.
- Console capture only occurs on the bound tab while a session is live.

## Provenance

Found during a full line-by-line audit. Verified the unconditional `chrome.tabs.onUpdated` listener and MAIN-world `executeScript` (`background.js:446-472`), with no `boundTabId`/session/host gate.

## Resolution (2026-10-05)

Resolved on wt/sdk-ext by removing console capture (/console_recent, the hook and its alarm).
