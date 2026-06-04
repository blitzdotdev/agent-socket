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

---

**CLOSED 2026-06-04** — landed Path A (vendor SDK as ES modules). Compiled SDK now copied from `sdk/dist/` into `chrome-extension/lib/sdk/` by `chrome-extension/scripts/vendor-sdk.sh`. The extension still loads-unpacked with no build step because vendored files are checked in. CI's `vendor-freshness` job re-runs the script and fails on a diff, so the vendored copy can't drift silently from SDK source.

Changes in this consolidation:

- `sdk/src/session.ts` (+5 LOC) — new public `Session.ping()` method, mirrors the `as-client.js` `pingNow()` semantics including the `pendingPingId !== null` guard. Lets the chrome ext's `chrome.alarms`-driven keepalive call into the SDK without re-implementing.
- `sdk/src/types.ts` (+8 LOC) — documents `Session.ping()` on the public interface.
- `chrome-extension/scripts/vendor-sdk.sh` (new, +50 LOC) — copies compiled SDK into `chrome-extension/lib/sdk/`, writes a `VENDORED.md` provenance file with the source SHA.
- `package.json` — `build` script now chains the vendor; new `ext:vendor` shortcut.
- `chrome-extension/background.js` — refactored to `import { connect, exponentialBackoff } from "./lib/sdk/index.js"`, renamed `client` → `session`, switched `mintToken(label)` → `mintAgentToken({label})`, `pingNow()` → `ping()`, replaced the chrome-ext-only `onStatusChange` with a local `emitStatus` helper that translates SDK's `onDisconnect` (initial + reconnect-failed) + `onSessionChanged` (post-reconnect) into the legacy `connecting/connected/disconnected/reconnect-failed/closed/idle` vocabulary that `popup.js` already speaks. Net diff: ~25 LOC added, ~10 LOC removed.
- `chrome-extension/test/reconnect.unit.mjs` — ported from `ASClient` to `connect()`/`Session`. 23/23 assertions pass (was 21; added coverage for the now-explicit `onDisconnect` reconnect call site and the post-`close()` no-further-events invariant).
- `chrome-extension/lib/as-client.js` — **deleted** (-370 LOC).
- `chrome-extension/README.md` and `sdk/README.md` — updated to reflect the new architecture.

Net code change: roughly **-370 LOC of duplicated wire-protocol logic in the extension**, replaced by a 25-line adapter around the SDK. Drift risk drops to zero — the wire protocol now has a single source of truth.

The originally-proposed Path B (extract `@agent-socket/protocol`) was rejected: the lifecycle code (reconnect, heartbeat, remint) is where drift actually risks happening, not the wire frames, so a "protocol-only" shared package wouldn't address the real problem. Path C (accept duplication, document it) was rejected for the same reason — the duplication was already producing real bugs (the `chrome-ext-ws-drops-no-reconnect` incident was exactly the drift this issue was filed to prevent).
