# agent-bridge: `tokensRemapped` treated as array, but SDK ships a Map → fanout dies on every reconnect

## What's wrong

`agent-bridge/index.mjs:118-127` defines the bridge's `onSessionChanged` handler:

```js
onSessionChanged: async ({ priorSessionId, sessionId, tokensRemapped }) => {
  log("info", `session changed → ${sessionId}; ${tokensRemapped.length} tokens remapped`)
  const fresh = tokensRemapped.find((t) => t.label === "outreach-bridge")
  if (!fresh) {
    log("warn", "no fresh URL after remint — campaigns left with dead URL")
    return
  }
  await fanoutBridgeUrl(fresh.url)
}
```

The SDK (and the channel protocol) ships `tokensRemapped` as `Map<oldUrl, newUrl>` — see `sdk/src/types.ts:90-96` and `sdk/src/session.ts:330-337`. `Map` doesn't have `.length` (it has `.size`), and doesn't have `.find` (it has `.get(key)` or `Array.from(map.entries()).find(...)`).

Concrete consequences on every reconnect:
- `tokensRemapped.length` → `undefined`. Log line says "session changed → X; undefined tokens remapped".
- `tokensRemapped.find(...)` → `TypeError: tokensRemapped.find is not a function`. Throws.

The throw is caught by the SDK's `void this.onSessionChanged(...)` site (`session.ts:347`) which swallows promise rejections. Net effect: **the bridge silently never re-fans-out the new URL** to its campaigns after a reconnect. Each campaign's `bot_config.agent_bridge_url` stays pointed at the dead pre-reconnect mint URL until the bridge process restarts.

This breaks the central guarantee in the bridge's own header comment (`index.mjs:1-4`):

> on every session change (initial connect + reconnect after relay DO cycles) the bridge PUTs the freshly-minted URL into each campaign's bot_config.agent_bridge_url.

## Why it matters

- Relay DOs cycle every ~70-140s (when no traffic) and on every relay deploy. So the bridge URL goes stale within minutes of running.
- The bridge's whole point is to keep campaigns wired to a live URL across relay restarts. With this bug, the bridge is no better than a one-shot script — it only works until the first reconnect.
- The bug is silent: logs show "session changed" + "undefined tokens remapped" but no error stack, because the SDK swallows the rejection.

## What to do

Treat the Map as a Map. The minimal fix:

```js
onSessionChanged: async ({ priorSessionId, sessionId, tokensRemapped }) => {
  log("info", `session changed → ${sessionId}; ${tokensRemapped.size} URLs remapped`)
  // We minted exactly one token per bridge (label "outreach-bridge"); look up by the prior URL.
  const freshUrl = tokensRemapped.get(lastFannedOutUrl)
  if (!freshUrl) {
    log("warn", "no fresh URL after remint — campaigns left with dead URL")
    return
  }
  lastFannedOutUrl = freshUrl
  await fanoutBridgeUrl(freshUrl)
}
```

Requires tracking the most-recently-fanned-out URL in a module-level variable. After the initial `mintAgentToken({label})` and the first `fanoutBridgeUrl`, save the URL. Use it as the lookup key on `onSessionChanged`. Same pattern as `chrome-extension/background.js:148` (which got this right).

## Acceptance

- A reconnect (force one via `bash scripts/deploy.sh tail` and then `_debug/kill-ws/<sessionId>`) triggers a successful `fanoutBridgeUrl` to all campaigns with the new URL.
- Log line says `2 URLs remapped` (or whatever the actual count is), not `undefined`.
- Add a smoke test: spawn the bridge, force-kill the relay's DO via `/_debug/kill-ws/`, assert the campaign endpoint received an updated `agent_bridge_url`.

## Provenance

Caught 2026-06-04 during the post-merge audit. Multiple agents independently flagged it. Pre-existing bug from commit `79897da` ("bridge") — not introduced by the consolidation work. The SDK type contract was correct; the bridge author wrote against an imagined API.
