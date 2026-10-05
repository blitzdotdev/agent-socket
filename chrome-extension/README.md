# Agent Socket — Chrome Extension

Connect any AI chat (Claude, ChatGPT, Gemini, …) to **one browser tab you
choose**. The extension acts as an agent-socket *app*: it opens a WebSocket
to the relay, registers a toolset bound to that tab, and gives you a
paste-able URL. Paste the URL into your AI chat and the AI can click, fill,
read, evaluate, and screenshot the page on your behalf.

While a tab is connected it shows an in-page "AI has access to this tab" bar
(last action time, time left + **Stop**) and an "AI" badge on the toolbar
icon. Stop, the popup's **Stop & disconnect**, closing the tab, or the
session timer running out ends the session and kills the URL.

## Session timer and site lock

- **Timer.** A session stops 60 minutes after Connect. The default length
  is in the popup's Settings (15 min, 30 min, 1 h, 2 h, 4 h, 8 h, No limit).
  The popup shows "Auto-stop in 42:10" with **Stop now**, **Change** (a new
  length from now) and **Remove timer** (no limit for this session); the bar
  shows "42 min left"; both turn red in the last minute. The deadline is
  saved with the session and enforced with `chrome.alarms`, so it holds
  across service-worker restarts and keeps counting while the relay is
  unreachable. Expiry is the same clean Stop as the Stop button. `/page_info`
  returns `session_ends_at` (ISO, or null).
- **Site lock** (on by default). Tools act only while the tab is on an
  allowed origin (scheme + host + port): at first the tab's origin at
  Connect. Every tool call checks the tab's current URL first, so links the
  AI clicked, redirects, `/eval` setting `location`, and the user browsing
  elsewhere are all caught; page code then runs pinned to the document that
  was checked (`documentIds`), so a navigation in between makes the call fail
  (409 `page_changed`) instead of running on the next site. Elsewhere, calls
  return 403 `origin_not_allowed` naming the tab's host, without touching the
  page, and `/navigate` refuses targets outside the allowed set (the
  local/private-host guard applies too). The registry tools
  (`/registry_search`, `/registry_get`, `/registry_submit`) don't touch the
  page and keep working while paused. `/page_info` returns `allowed_origins`
  (or `"any"`).
- **Paused.** The bar turns blue: "AI paused: tab left github.com ·
  [Allow mail.google.com] [Stop]"; the popup shows the same, the allowed
  sites (removable), and **Let the AI use other sites in this tab** (per
  session; its default for new sessions is in Settings, off). Allow adds that
  exact origin for this session. Allow reacts only to real clicks
  (`isTrusted`), and the bar's only while the page isn't covering it
  (IntersectionObserver v2); otherwise it points to the toolbar icon.
- **Tools follow the tab.** On an allowed site with another host than the
  loaded tools, the extension fetches that site's registry profile (plus a
  kept local profile) and swaps the session's tools with `updateTools()`, on
  the same link; back on the first site, its tools come back. A paused tab
  keeps the loaded tools.

The relay holds a dropped connection's session for 24 hours, so the URL
survives network loss, laptop sleep and service-worker restarts: the bar
says "AI access: reconnecting…" meanwhile, and a restarted worker that can't
reach the relay yet keeps the link and keeps retrying. If a drop outlasts the
24 hours (or the relay lost the session), the extension gets a new URL and
the old one is dead. It then
says so until you copy the new one or the AI uses it: the bar turns amber
("Link changed — paste the new link into your AI chat", with **Copy link**
and **Stop**), the badge reads "NEW", and the popup shows a banner with the
new link and why it changed. The popup's Settings list the last few
connection events (drops, close codes, resumes), kept in memory only.

## What it exposes

**Universal tools** (work on any site, registered on every connection):

| Path | What it does |
| --- | --- |
| `POST /eval` | Run arbitrary JS in the page's main world. The escape hatch — use this first on unfamiliar sites to find selectors. |
| `POST /page_info` | URL, title, host, viewport, scroll position, short text excerpt; `session_ends_at` and `allowed_origins`. |
| `POST /dom_query` | `querySelectorAll`, returns tag/id/classes/text/attrs of matches. |
| `POST /click` | Click first element matching a selector. |
| `POST /fill` | Fill an `<input>` / `<textarea>` / `contenteditable`. Dispatches input+change so React/Vue notice. |
| `POST /wait_for` | Poll a selector until present (or absent), with timeout. |
| `POST /navigate` | Navigate the connected tab to an http(s) URL; refuses sites outside the allowed set (403 `origin_not_allowed`) and local/private-network hosts. Waits for load by default. |
| `POST /scroll` | Scroll into view by selector, or to absolute/relative pixels. |
| `POST /get_text` | `innerText` of selector (or body), truncated. |
| `POST /get_html` | `outerHTML` of selector. |
| `POST /screenshot` | PNG/JPEG data-URL of the visible viewport. Refused (409) unless the connected tab is the selected tab of its window. |
| `POST /save_site_profile` | Save tools for a host on this computer as **pending**; they load only after the user clicks Keep in the popup. |
| `POST /registry_search` | Search the shared registry (hosts, notes, tool names/descriptions); compact hits. |
| `POST /registry_get` | A site's approved registry profile: notes + tool list (code only with `include_code: true`). Defaults to the tab's host. |
| `POST /registry_submit` | Send `{ host, notes, tools }` to the registry as a submission (validated locally first); pending maintainer review. |

**Site-specific tools** come from two places:

- **The registry** ([`registry/`](../registry), default `https://registry.agentsocket.dev`, configurable in the popup's Settings). On Connect the extension fetches `GET /v1/sites/<hostname>` and registers its tools and notes; if the site has none it uses the generic profile (`*`). The fetch has a 3 s budget: if the registry is unreachable the tab connects with the built-in tools and the popup says so. Hostnames that can't be in the registry (IPs, `localhost`, `.local`/`.lan`/`.internal` names) are never sent; those tabs get the generic profile. Starter profiles live in [`registry/seed/`](../registry/seed).
- **Local profiles** the AI saved with `/save_site_profile`. A save is *pending*: the popup shows "AI saved N tools for <host>" with **Keep** / **Discard** and a Review of the code. Only kept profiles load (stored in `chrome.storage.local` `kept_profiles[host]`, matched on `host:port` then hostname). A kept tool replaces a registry tool with the same method + path. Keeping (or deleting) a profile for the connected tab's host updates the live session through `session.updateTools()`, so the new tools show up in `tools.json` on the same URL. Profiles saved by older versions (`site_profiles`) are moved to pending on upgrade.

## The agent flow

1. User clicks the toolbar icon → popup opens.
2. User clicks **Connect this tab** → Chrome asks once for site access
   (an optional permission, not granted at install) → background opens the
   WS, registers the tools (base + site profile), mints a paste link.
3. User copies the link, pastes into their AI chat.
4. AI fetches `/agents.md` and `/tools.json`, then calls tools as it works.

On a **new** site, the AI first checks `/registry_search` / `/registry_get`,
then calls `POST /eval` to explore (find selectors, test that interactions
work). When it finds something stable, it calls `POST /save_site_profile
{ host, tools: [...] }`; once the user clicks Keep, the tools appear in
`tools.json` on the same URL and on later connections to that host. To share
them, it calls `POST /registry_submit`, which queues them for review.

## Install (developer mode)

1. Visit `chrome://extensions/`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** → select this directory.
4. (Optional) In the popup's **Settings**, set the relay base URL and the
   tool registry URL if you're self-hosting (defaults:
   `https://agentsocket.dev`, `https://registry.agentsocket.dev`).

`/eval` and site tools run through `chrome.userScripts` so they work on
CSP-strict sites. That needs **Allow User Scripts** turned on in the
extension's details page (Chrome 138+; Developer mode on Chrome 135–137); the
popup shows how when it's off.

## Packaging

`npm run ext:zip` rebuilds + re-vendors the SDK and writes
`chrome-extension/dist/agent-socket-extension.zip` (runtime files only).

## Tests

The E2E test launches Chromium under Xvfb with the extension loaded, runs a
tiny `wrangler dev` relay, serves a local test page plus a mock registry
(same JSON API as `registry/`, on the static server under `/registry`), and
verifies the tools by hitting the agent token URL exactly like an external AI
chat would. The page is opened as `http://e2e-site.test:<port>` (Chromium's
`--host-resolver-rules` maps it to 127.0.0.1) because the registry only knows
public-looking hostnames.

```bash
# Requires xvfb-run + chromium (sudo apt install xvfb chromium).
CHROMIUM_PATH=/usr/bin/chromium npm run ext:test
```

Coverage: connect/mint, meta endpoints, page info, eval (success/error/await),
DOM query, click/fill/submit, wait_for, scroll, text/html, dynamic lists,
screenshot (and its refusal when another tab is in front), navigate guard,
registry profile on Connect, generic fallback, connecting with the registry
down, `/registry_search` / `/registry_get` / `/registry_submit`,
`/save_site_profile` → pending → Keep (tools live on the same URL) /
Discard / delete, kept tools loading on reconnect, legacy profile migration,
badge + pill on the bound tab only,
popup state, pill re-injection after reload, tab close and pill Stop ending
the session, the session timer (pill + popup, Change, Remove, expiry ending
the session; a hidden `test_session_ms` storage key sets a short deadline),
the site lock (`/navigate` refused, a tab sent elsewhere by `/eval` pausing
calls and the bar, Allow in the bar and the popup, removing a site, the
any-site toggle) and the tool swap to a second site's registry profile on the
same link (the page is also served as `e2e-other.test`), and connect being
refused without site access. `SHOT_DIR=<dir>` saves pill and popup screenshots. Puppeteer can't
click Chrome's permission prompt, so the tests load a copy of the extension
with site access granted at install (`test/ext-dir.mjs`).

`npm run ext:test:unit` (no chromium) drives the vendored SDK's reconnect path
(resume, then re-mint when the session is gone) against a mocked WebSocket,
checks the `/navigate` URL guard, tests profile validation, merging and
agents.md (`test/profiles.unit.mjs`, which also checks the built-in tool paths
match `registry/src/rules.ts`), and the timer arithmetic and origin check
(`test/limits.unit.mjs`). `npm run ext:test:reconnect` (chromium)
checks the same URL survives a relay-side WS drop and a service-worker stop
(with the timer, its alarm and the allowed sites kept),
and that a new URL is minted once the session is gone, with the link-changed
bar, badge and popup banner, cleared by Copy (popup or bar) or a tool call.
`SHOT_DIR=<dir>` saves screenshots of that state.

## Architecture in one paragraph

`background.js` is an ES-module service worker. On `connect`, it imports
`@agent-socket/sdk` (vendored at `lib/sdk/`; see `lib/sdk/VENDORED.md`),
registers a toolset built from `lib/tools-base.js` + `lib/registry.js`
(universal) plus the site profile from the registry and the user's kept local
profile (`lib/profiles.js` merges them and writes agents.md), mints an agent token, and marks the tab (badge + `pill.js`
injected into the page's isolated world). Each tool's handler runs in the
service worker and forwards work into the page via
`chrome.scripting.executeScript({ world: "MAIN", ... })`, which has full
access to page globals. Tool input is parsed from the JSON body the relay
forwards; output is whatever the handler returns. The popup (`popup.html`)
is a thin client that exchanges `chrome.runtime.sendMessage` calls with the
SW. A `chrome.alarms` keepalive fires every 30s and calls `session.ping()`
to keep the WS warm against MV3 service-worker idle-kill. A dropped WS
resumes the same session, so the pasted URL keeps working. The live session
(tab, session id, resume secret, URL, timer deadline, allowed origins) is
kept in `chrome.storage.session`, so
a restarted service worker resumes it too; only if the relay has ended the
session does the extension mint a new URL, and the bar, badge and popup tell
the user the link changed (`linkChanged` in background.js).
