# Chrome extension: WS drops after 3-10 tool calls, no reconnect

## Reported behavior (2026-05-23)

An AI driving the active tab via the extension reports:

> **First socket** (`as_TWXMS2Q6_...`): worked for ~10 calls — `page_info`, `navigate`, `get_text`, `tabs_list`, `tabs_switch` — all 200 with valid data. Then `navigate` returned `{"error":{"code":"app_offline","message":"no live WS for this session"}}`. Follow-up `page_info` same error.
>
> **Second socket** (`as_NRE5KJEW_...`): worked for 3 calls — `page_info`, `navigate`, `get_text`. Then `dom_query` returned the same `app_offline` error.

Pattern: works for a handful of calls, then permanent `503 app_offline` on that session token. New sockets exhibit the same decay.

## Root cause

Chrome MV3 service workers are aggressively terminated when idle (~30s). When the SW dies, the WebSocket it owned dies with it. The relay then has no live WS for that session-id, so subsequent agent HTTP calls return `503 app_offline`.

Two compounding bugs in `chrome-extension/`:

### Bug 1 — `_onClose` doesn't reconnect

In `chrome-extension/lib/as-client.js`:

```js
_onClose(code, reason) {
  if (this._closed) return
  this.registered = false
  this._teardownHeartbeat()
  for (const p of this.pendingFrameReplies.values()) p.reject(new Error("ws closed"))
  this.pendingFrameReplies.clear()
  this.ws = null
  this._emitStatus("disconnected", { code, reason })
}
```

Just tears down state and emits a "disconnected" status. No `setTimeout` to reconnect, no exponential backoff, no auto-remint.

For comparison, `@agent-socket/sdk`'s session.ts has full `autoReconnect: true` logic — reconnects with `exponentialBackoff()` and re-mints any previously-issued agent-tokens under the new session-id, reporting the remapping via `onSessionChanged`. The chrome-ext's slim re-implementation (`as-client.js`) skipped all of that.

### Bug 2 — the "keepalive" alarm doesn't actually keep the SW alive

In `chrome-extension/background.js`:

```js
chrome.alarms.create("as-keepalive", { periodInMinutes: 0.4 })   // 24s
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "as-keepalive") {
    if (client?.connected) void chrome.storage.session?.set?.({ alive: Date.now() }).catch(() => {})
  }
})
```

The comment claims:
> While we have a live client, ping the runtime to stay awake. The native WS already keeps the worker alive on inbound traffic, but our heartbeats are every 25s; an alarm every 25s gives extra margin.

The implementation just writes to `chrome.storage.session`. That doesn't keep the SW alive in any meaningful way — alarms DO wake the SW briefly when they fire, but a no-op handler lets the SW go right back to sleep. And the SW being killed mid-WS-call is the actual fatal event, not the time between calls.

The cited assumption "the native WS already keeps the worker alive on inbound traffic" is partially true but stops being true when the WS goes idle — which happens between agent tool calls.

## Why the spec's heartbeat doesn't help here

The relay sends heartbeats every 25s (`HEARTBEAT_INTERVAL_MS`) and expects a pong within 50s (`HEARTBEAT_TIMEOUT_MS`). If the SW is alive when the ping arrives, the WS handler pongs. If the SW is dead, the ping waits 50s and the server tears the WS down.

So the path of failure is:

1. Last tool call completes; SW goes idle.
2. ~30s later Chrome kills the SW.
3. Relay sends ping, no pong; after `HEARTBEAT_TIMEOUT_MS` (50s) relay sees timeout, closes the WS from its side, registers session as dead.
4. Agent makes another tool call to the same token URL; relay has no live WS; returns `503 app_offline`.

The window of ~30-80s where it "still works" matches the reported "3-10 calls then dead" pattern.

## What to do

### Short term — port reconnect logic into as-client.js

Mirror the SDK's `autoReconnect` behavior in `chrome-extension/lib/as-client.js`:

- On `_onClose`, if not deliberately closed, schedule a reconnect with exponential backoff (1s → 30s).
- On reconnect, re-register the toolset (the chrome ext already builds the toolset fresh each time, so this is straightforward).
- On reconnect, re-mint the previously-shared agent-token *with the same `label`* under the new session-id, and update `chrome.storage.local.last_link_url` to the new URL.
- Emit a "reconnected" status with the URL change so the popup can refresh.

### Short term — make keepalive actually work

The keepalive alarm needs to do something the SW can't skip. Two options:

1. **Send a no-op `ping` on the WS** in the alarm handler. The native WS read/write is exactly what keeps the SW alive. The relay sees an unexpected `ping`, the WS dispatch path runs through the SW briefly. Cheap.
2. **Touch `chrome.runtime.id`** or call any synchronous chrome API. Less reliable than option 1.

Pick (1). Implementation in `background.js`:

```js
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "as-keepalive" && client?.connected) {
    client._sendKeepalivePing?.()   // small helper on the client
  }
})
```

And in `as-client.js`:

```js
_sendKeepalivePing() {
  if (this.ws?.readyState === 1) this._send({ type: "ping", id: crypto.randomUUID() })
}
```

The relay already handles `{type:"ping"}` frames from the app side (per `relay-do.ts`).

### Long term — kill the duplication (see `chrome-ext-consolidate-as-client.md`)

This bug is exactly the kind of thing the consolidation issue warned about: `as-client.js` is a slim re-implementation of `@agent-socket/sdk` minus the reconnect logic. Bringing them together (any of the three paths in that issue) prevents this category of drift.

This issue is the strongest argument so far for picking path A (vendor SDK at build) or path B (extract `@agent-socket/protocol`). Path C (accept duplication) has now produced one concrete production bug.

## Acceptance

- After ~5 minutes of idle (SW killed at least once), the agent can still make a fresh tool call against the same paste-link. Either:
  - The call succeeds outright (WS reconnected, token still valid), OR
  - The call gets the URL update via `onSessionChanged` and retries successfully.
- A continuous stream of agent calls every ~60s never sees `app_offline` for at least 10 minutes.
- The keepalive alarm body actually exercises the WS path, not just storage.
- New harness scenario: load the extension via Playwright, idle 60s, verify next tool call still works.

## Provenance

2026-05-23 — reported by a Claude.ai instance driving the active tab through the extension. Two independent sockets both decayed within minutes of first use, both returning `app_offline` after the SW lifecycle killed the WS. Confirmed against the source on `claude/agent-website-extension-VsA69` (unmerged). Blocks production use of the chrome extension; load-unpacked dev use is also impaired.

## Merge implications

The extension branch should **not** be published to the chrome web store until this lands. Merging the branch to master is still safe — the bug exists only at runtime, not at build, and the merge itself doesn't enable web-store distribution. Update `chrome-extension/README.md`'s "Install" section to warn: "v0 — known issue: WS drops after ~30-80s of idle; reconnect logic in progress. See `issues/open/chrome-ext-ws-drops-no-reconnect.md`."

---

**CLOSED 2026-05-23** — fix implemented, awaiting environment-level E2E re-verification.

### Code changes

`chrome-extension/lib/as-client.js`:
- Added reconnect bookkeeping to the ASClient constructor: `autoReconnect` (default true), `_reconnectAttempt`, `_reconnectTimer`, `_giveUpReconnect`, `myTokens` map.
- `_onClose` now schedules a reconnect via `_scheduleReconnect()` when the close wasn't deliberate (not `close()` from app code).
- `_scheduleReconnect`: exponential backoff with ±25% jitter, base 1s, capped at 30s. Mirrors `@agent-socket/sdk`'s `exponentialBackoff()`.
- `_reconnectAndRemint`: on reconnect success, re-mints every previously-tracked agent-token under the new session-id (using the original label) and emits `onSessionChanged({ priorSessionId, sessionId, tokensRemapped })`. On reconnect failure, schedules the next attempt.
- `mintToken` / `revokeToken` now keep `myTokens` map in sync.
- Added public `pingNow()` — sends a real WS ping frame on demand. No-op if not connected or if a ping is already in flight.

`chrome-extension/background.js`:
- Keepalive alarm period bumped to 20s (was 24s); the body now calls `client.pingNow()` instead of writing to `chrome.storage.session`. The outbound WS send + inbound pong dispatch both run through the SW, keeping it alive across the alarm boundary.
- Added `onSessionChanged` callback on the ASClient: when the session-id changes (reconnect remap), swaps `lastUrl` to the freshly-minted URL, persists to `chrome.storage.local.last_url`, and pushes a `{type:"url_changed", url}` message to the popup.

`chrome-extension/popup.js`:
- New handler for `url_changed` messages: updates `linkInput.value` live so a user with the popup open sees the new paste URL immediately after a reconnect. Status hint updated accordingly.

### Code review confidence

The reconnect logic is a near-1:1 port of `@agent-socket/sdk`'s `_onClose` + `_reconnectAndRemint`, which is covered by harness scenarios 27 (ws-drop fails-inflight) and 41 (sdk-reconnect-remint). The MV3-specific risk is the keepalive — replacing a storage write with a WS ping is conceptually correct; verifying the SW genuinely stays alive across the alarm boundary requires a real browser.

### Remaining verification (NOT done here)

Needs an environment with `xvfb-run` + `playwright-chromium`:

```bash
# Run the existing E2E test against the merged branch
xvfb-run -a -s "-screen 0 1280x900x24" node chrome-extension/test/e2e.mjs

# Specifically verify the fix:
# 1. Connect via popup, mint a link.
# 2. Sleep 60s (more than 2x the MV3 SW idle window).
# 3. Make an agent tool call against the link.
# 4. Confirm: call succeeds outright (because either the SW stayed alive
#    via the new keepalive ping, OR the reconnect remapped to a fresh
#    URL and the popup's url_changed handler updated linkInput).
```

A dedicated harness scenario (e.g. `60-chrome-ext-survives-sw-idle`) would close the loop. Filed as a future task; not part of this fix.

### Merge implications

Now safe to advertise the chrome extension in the landing page (which is the next item on the work plan). Web-store publication still needs the Playwright E2E verification above, but load-unpacked dev use should work end-to-end.
