# Agent Socket — Chrome Extension

Connect any AI chat (Claude, ChatGPT, Gemini, …) to **one browser tab you
choose**. The extension acts as an agent-socket *app*: it opens a WebSocket
to the relay, registers a toolset bound to that tab, and gives you a
paste-able URL. Paste the URL into your AI chat and the AI can click, fill,
read, evaluate, and screenshot the page on your behalf.

While a tab is connected it shows an in-page "AI has access to this tab" bar
(last action time + **Stop**) and an "AI" badge on the toolbar icon. Stop,
the popup's **Stop & disconnect**, or closing the tab ends the session and
kills the URL.

## What it exposes

**Universal tools** (work on any site, registered on every connection):

| Path | What it does |
| --- | --- |
| `POST /eval` | Run arbitrary JS in the page's main world. The escape hatch — use this first on unfamiliar sites to find selectors. |
| `POST /page_info` | URL, title, host, viewport, scroll position, short text excerpt. |
| `POST /dom_query` | `querySelectorAll`, returns tag/id/classes/text/attrs of matches. |
| `POST /click` | Click first element matching a selector. |
| `POST /fill` | Fill an `<input>` / `<textarea>` / `contenteditable`. Dispatches input+change so React/Vue notice. |
| `POST /wait_for` | Poll a selector until present (or absent), with timeout. |
| `POST /navigate` | Navigate the connected tab to an http(s) URL; refuses local/private-network hosts (a guardrail — `/eval` can still navigate). Waits for load by default. |
| `POST /scroll` | Scroll into view by selector, or to absolute/relative pixels. |
| `POST /get_text` | `innerText` of selector (or body), truncated. |
| `POST /get_html` | `outerHTML` of selector. |
| `POST /screenshot` | PNG/JPEG data-URL of the visible viewport. Refused (409) unless the connected tab is the selected tab of its window. |
| `POST /save_site_profile` | Persist a discovered toolset keyed by hostname. After reconnect those tools are first-class. |

**Site-specific tools** (loaded automatically based on the connected tab's host):

- `tools-lib/_index.json` maps host patterns → tool files.
- Bundled profiles: `github.com.json`, `x.com.json` (+ `twitter.com` alias), `news.ycombinator.com.json`, `reddit.com.json` (+ `www.reddit.com` alias), `docs.google.com.json`, plus a `generic.json` fallback.
- User-saved profiles (via `/save_site_profile`) live in `chrome.storage.local`
  under `site_profiles[host]` and take precedence over bundled ones.

## The agent flow

1. User clicks the toolbar icon → popup opens.
2. User clicks **Connect this tab** → Chrome asks once for site access
   (an optional permission, not granted at install) → background opens the
   WS, registers the tools (base + site profile), mints a paste link.
3. User copies the link, pastes into their AI chat.
4. AI fetches `/agents.md` and `/tools.json`, then calls tools as it works.

On a **new** site, the AI calls `POST /eval` to explore (find selectors, test
that interactions work). When it finds something stable, it calls
`POST /save_site_profile { host, tools: [...] }` to save it. On the next
connection to that host the saved tools appear in `tools.json` automatically.

## Install (developer mode)

1. Visit `chrome://extensions/`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** → select this directory.
4. (Optional) In the popup's **Settings**, set the relay base URL if you're
   self-hosting (default is `https://agentsocket.dev`).

`/eval` and site tools run through `chrome.userScripts` so they work on
CSP-strict sites. That needs **Allow User Scripts** turned on in the
extension's details page (Chrome 138+; Developer mode on Chrome 135–137); the
popup shows how when it's off.

## Packaging

`npm run ext:zip` rebuilds + re-vendors the SDK and writes
`chrome-extension/dist/agent-socket-extension.zip` (runtime files only).

## Tests

The E2E test launches Chromium under Xvfb with the extension loaded, runs a
tiny `wrangler dev` relay, serves a local test page, and verifies the tools by
hitting the agent token URL exactly like an external AI chat would.

```bash
# Requires xvfb-run + chromium (sudo apt install xvfb chromium).
CHROMIUM_PATH=/usr/bin/chromium npm run ext:test
```

Coverage: connect/mint, meta endpoints, page info, eval (success/error/await),
DOM query, click/fill/submit, wait_for, scroll, text/html, dynamic lists,
screenshot (and its refusal when another tab is in front), navigate guard,
save_site_profile + reconnect-loads-saved, badge + pill on the bound tab only,
popup state, pill re-injection after reload, tab close and pill Stop ending
the session, and connect being refused without site access. Puppeteer can't
click Chrome's permission prompt, so the tests load a copy of the extension
with site access granted at install (`test/ext-dir.mjs`).

`npm run ext:test:unit` (no chromium) drives the vendored SDK's reconnect path
against a mocked WebSocket and checks the `/navigate` URL guard.

## Architecture in one paragraph

`background.js` is an ES-module service worker. On `connect`, it imports
`@agent-socket/sdk` (vendored at `lib/sdk/`; see `lib/sdk/VENDORED.md`),
registers a toolset built from `lib/tools-base.js` (universal) plus the site
profile (if any), mints an agent token, and marks the tab (badge + `pill.js`
injected into the page's isolated world). Each tool's handler runs in the
service worker and forwards work into the page via
`chrome.scripting.executeScript({ world: "MAIN", ... })`, which has full
access to page globals. Tool input is parsed from the JSON body the relay
forwards; output is whatever the handler returns. The popup (`popup.html`)
is a thin client that exchanges `chrome.runtime.sendMessage` calls with the
SW. A `chrome.alarms` keepalive fires every 30s and calls `session.ping()`
to keep the WS warm against MV3 service-worker idle-kill.
