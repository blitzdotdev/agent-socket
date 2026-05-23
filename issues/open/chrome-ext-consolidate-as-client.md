# Chrome extension: consolidate `as-client.js` into `@agent-socket/sdk`

## What's duplicated

The chrome extension (branch `claude/agent-website-extension-VsA69`, unmerged) ships its own slim re-implementation of the SDK protocol at `chrome-extension/lib/as-client.js` instead of importing `@agent-socket/sdk`. Both implementations speak the same WS frame protocol — they have to, by definition, since they talk to the same relay. So we have two copies of the wire-handling logic, with subtle drift waiting to happen:

| Concern | Drift risk |
|---|---|
| `DEFAULT_BASE_URL` | Already flipped in SDK to aisocket.dev (2026-05-23). Will need a parallel flip in as-client.js (filed as separate issue). |
| Heartbeat constants | Hard-coded in both; if defaults change in one, the other lags. |
| `mintAgentToken` shape | If the SDK adds a new field (e.g. expiry hint), the chrome ext silently doesn't know about it. |
| Reconnect / remint logic | The SDK has well-tested reconnect; the chrome ext has a parallel implementation we'd need to test independently. |

## Why it's separate today

Chrome extensions don't bundle npm dependencies the same way Node packages do. Importing `@agent-socket/sdk` directly via ES modules in a manifest-v3 service worker is possible but requires either a build step (esbuild → single-file output) OR vendoring the SDK into the extension at build time.

The current branch took the easier path: re-implement the minimum needed. Workable, but technical debt.

## What to do

Two reasonable paths — pick after the chrome extension lands and we see real usage patterns:

### Path A — vendor the SDK at build time

Add a build script that takes `packages/agent-socket/sdk/dist/index.js`, copies (or bundles + minifies) it into `chrome-extension/lib/sdk-bundled.js`, then `chrome-extension/background.js` and `popup.js` import from there. The vendoring is part of the extension's build, run before zipping for the web store.

Pros: SDK is the single source of truth; chrome ext is a thin adapter.
Cons: build step required (currently the extension is load-unpacked-able with no build).

### Path B — extract the wire protocol into a tiny shared package

Make `@agent-socket/protocol` (or similar) — a 100-line package with just frame definitions, URL builders, no I/O. Both `@agent-socket/sdk` (Node + browser) and `chrome-extension/lib/as-client.js` import from it. The remaining I/O code in each stays separate because their transport assumptions differ (chrome.runtime vs. node ws vs. browser WebSocket).

Pros: smallest blast radius; no build step for the extension.
Cons: a new package to maintain.

### Path C — accept the duplication

If as-client.js stays ~150 lines and the protocol is genuinely frozen at v0, drift is manageable. Document in a comment that as-client.js mirrors `@agent-socket/sdk` and changes there must be ported here.

Pros: no work.
Cons: drift is inevitable as v1 lands.

## Acceptance (whichever path is picked)

- A change to the WS frame protocol requires editing ONE file, not two.
- Or — explicit, documented two-place edit with a CI check ("if `sdk/src/transport.ts` changes, was `chrome-extension/lib/as-client.js` also updated?").

## Provenance

Caught while reviewing the unmerged chrome-extension branch for deployment impact 2026-05-23. Not deploy-blocking — relay doesn't care. Worth landing as a v1 cleanup after the extension has been in use long enough to know which path is appropriate.
