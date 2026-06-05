# chrome-ext: onSessionChanged adapter only updates one minted URL

## What's wrong

`chrome-extension/background.js`'s `onSessionChanged` handler (around line 169 after the SDK consolidation in `a4c7926`) looks up exactly `lastUrl` in the `tokensRemapped` Map and forwards the replacement via `chrome.runtime.sendMessage({type: "url_changed", url: ...})`:

```js
onSessionChanged: ({ sessionId, tokensRemapped }) => {
  const fresh = tokensRemapped.get(lastUrl)
  if (fresh) {
    lastUrl = fresh
    ...
  }
  emitStatus({ status: "connected", sessionId })
},
```

If a future feature mints more than one token per session — for instance a sub-flow that hands out a scoped URL, or a chrome-ext API for tool-side mint — only the URL stored in `lastUrl` gets refreshed. Every other minted URL is correctly re-minted by the SDK and present in `tokensRemapped`, but the adapter forwards no notification for them. Holders of those URLs have no way to discover their replacement; their copies silently break after the next reconnect.

Same shape applies to `lastToken`: the adapter doesn't refresh it after reconnect either. Today this is harmless because `lastToken` isn't read by anything that polls (popup only displays `lastUrl`), but it's a latent bug.

## Why it matters

Today: harmless — the chrome-ext only ever mints one token (`mintAgentToken({label: "chrome-extension"})` once, on connect).

Tomorrow: as soon as someone adds a feature that mints additional tokens (a per-tab scope, a popover scope, a CLI bridge), reconnect silently breaks those URLs without any error surface to debug from.

## What to do

Two paths:

1. **Iterate the full `tokensRemapped` Map.** Send a `url_changed` message for each old→new pair, and persist a `{[oldUrl]: newUrl}` map to `chrome.storage.local` so callers can look up their replacement. Generalizes the adapter without committing to a specific multi-mint pattern.

2. **Document the constraint explicitly.** Add a comment that this adapter handles exactly one minted URL and any caller wanting more should manage their own remap by subscribing to onSessionChanged via a future SDK message channel. Keep behavior simple until a real use case appears.

Option 1 is ~10 LOC and forward-compatible. Recommend it.

## Acceptance

- Adding a second `await session.mintAgentToken({label: "..."})` in `startConnect` doesn't silently lose its URL after a reconnect.
- Either a `url_changed` message fires for each remapped URL, or storage has a queryable old→new map.

## Provenance

Surfaced 2026-06-05 by an extra-high-effort `/code-review` of the SDK-consolidation deploy. Latent — not user-visible today, only relevant when a multi-mint feature lands.
