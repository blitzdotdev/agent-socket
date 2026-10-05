# chrome-ext: `/console_recent` returns stale, empty, or wrong-tab data — cache is only refreshed by an active-tab alarm

## What's wrong

`/console_recent` (`tools-base.js:647-658`) reads from `getRecentConsole` (`background.js:52-54`), which returns whatever is in the `consoleByTab` cache. That cache is written by exactly one place: the `as-pull-console` alarm (`background.js:501-508`), which pulls from `getActiveTabId()`:

```js
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "as-pull-console") return
  const tabId = await getActiveTabId()
  ...
  consoleByTab.set(tabId, msgs)
})
```

The handler never calls `pullConsoleFromPage` on demand (the long comment at `background.js:488-500` explicitly acknowledges the intended on-demand refresh was never wired up).

## Why it matters

For a bound **background** tab:

- the alarm fires at most every ~30 s (MV3 clamps `chrome.alarms` to a 30 s floor) and the SW may have been suspended in between, so the cache is routinely empty;
- `getActiveTabId` returns the bound tab only while it's alive and focused-equivalent — otherwise the cache reflects a *different* tab than the one a synchronous `/console_recent` call targets;
- combined with the `getActiveTabId` active-tab fallback (separate issue), the cache can hold the user's current-tab console rather than the bound tab's.

Net: the AI calls `/console_recent` expecting the bound tab's recent logs and silently gets `[]` or another tab's output, with no error. It then reasons on missing/wrong diagnostic data.

## What to do

- Make `/console_recent` pull on demand from the correct (bound) tab via `pullConsoleFromPage(boundTabId, limit)` at call time, rather than relying on the periodic active-tab alarm.
- If a cache is kept, key it on the bound tab and refresh it synchronously in the handler.

## Acceptance

- `/console_recent` returns the bound tab's recent console messages at call time, even for a background tab and even if the SW was just woken.
- It never returns another tab's console.

## Provenance

Found during a full line-by-line audit. Verified `getRecentConsole` reads `consoleByTab` (`background.js:52-54`); the only writer is the `as-pull-console` alarm keyed on `getActiveTabId()` (`:501-508`); the handler's own comment (`:488-500`) notes the on-demand refresh was abandoned.

## Resolution (2026-10-05)

Resolved on wt/sdk-ext by removing console capture.
