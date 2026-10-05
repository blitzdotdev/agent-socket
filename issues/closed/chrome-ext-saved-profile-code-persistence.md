# chrome-ext: AI-saved site-profile `code` persists and auto-executes in MAIN world on the next connect — stored remote-code primitive

## What's wrong

`/save_site_profile` (`chrome-extension/lib/tools-base.js:724-764`) lets the remote AI store an arbitrary `code` string per host into `chrome.storage.local`:

```js
{ host, tools: [{ path, description, code }] }   // code is an arbitrary JS string
```

On the next connection to that host, `loadSiteProfileForUrl` (`background.js:56-81`, called at `:134`) loads the profile, and `buildSiteTools` wraps each `t.code` into a MAIN-world user script that runs via `chrome.userScripts.execute({ world: "MAIN", ... })` (`tools-base.js:786-797`):

```js
const wrapped = buildSiteToolScript(t.code, args, timeoutMs)
const results = await chrome.userScripts.execute({ ..., world: "MAIN", js: [{ code: wrapped }] })
```

The saved `code` is AI-authored, persists across browser restarts, and runs again on **any** later connection to that host — including a connection started by a *different* AI session, or a keybind auto-connect the user triggers.

## Why it matters

A single earlier AI session can plant code keyed to a high-value host (`mail.google.com`, `github.com`, an internal admin domain). It persists, and the next time anyone connects to that host the planted code runs in the page's MAIN world with CSP bypassed and same-origin DOM/fetch. There is:

- no signing or review of saved profile code,
- no "this profile was added by a remote party" warning (the popup lists only hostnames — `popup.js:59-71`),
- no expiry or provenance tracking.

This turns untrusted remote input into auto-executing privileged code — a stored-code / supply-chain persistence issue layered on top of the live-`/eval` capability.

## What to do

- Treat saved-profile `code` as untrusted: at minimum, surface in the popup that a profile for host X was added by an agent session, with the ability to review/delete it before it ever auto-runs.
- Require explicit user confirmation before a *saved* (vs. session-live) profile's code executes, especially on a keybind auto-connect.
- Consider dropping arbitrary `code` from saved profiles entirely in favor of a constrained, declarative action set; or scope saved profiles so they only apply within the session that created them unless the user promotes them.

## Acceptance

- A profile saved by the AI does not silently auto-execute on a later/independent connection without the user being able to see and revoke it first.
- The popup shows agent-added profiles distinctly from user-added ones.

## Provenance

Found during a full line-by-line audit. Verified the store path (`/save_site_profile`, `tools-base.js:724-764`), the load path (`background.js:56-81`, `:134`), and the MAIN-world execution of `t.code` (`tools-base.js:786-797`). The popup only lists hostnames (`popup.js:59-71`), with no provenance/warning.

## Resolution (extension 0.3.0)

`/save_site_profile` now stores the profile as **pending** (`chrome.storage.local` `pending_profiles`). Pending profiles never load or run. The popup lists each one as "AI saved N tools for <host>" with **Keep** / **Discard** and a Review section showing every tool's method, path, description and code. Only after Keep does the profile move to `kept_profiles` and load (immediately, via `update_tools`, if that host is the connected tab, and on later connections). Kept profiles are listed in Settings with delete, separately from registry tools. Profiles saved by earlier versions (`site_profiles`) are moved to pending on upgrade, so they need a Keep too. Shared profiles now come only from the reviewed registry. Covered by `chrome-extension/test/e2e.mjs` (pending not loaded → Keep → live; Discard; legacy migration; delete).
