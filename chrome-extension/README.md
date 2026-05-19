# Agent Socket — Chrome Extension

Connect any AI chat (Claude, ChatGPT, Gemini, …) to **whatever website you're
looking at**. The extension acts as an agent-socket *app*: it opens a WebSocket
to the relay, registers a toolset that targets the active tab, and gives you a
paste-able URL. Paste the URL into your AI chat and the AI can click, fill,
read, evaluate, and screenshot the page on your behalf.

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
| `POST /navigate` | Navigate the active tab. Waits for load by default. |
| `POST /scroll` | Scroll into view by selector, or to absolute/relative pixels. |
| `POST /get_text` | `innerText` of selector (or body), truncated. |
| `POST /get_html` | `outerHTML` of selector. |
| `POST /screenshot` | PNG/JPEG data-URL of the visible viewport. |
| `POST /tabs_list` | List open tabs in the current window. |
| `POST /tabs_switch` | Switch the active tab. |
| `POST /console_recent` | Last N console messages from the page. |
| `POST /save_site_profile` | Persist a discovered toolset keyed by hostname. After reconnect those tools are first-class. |

**Site-specific tools** (loaded automatically based on the active tab's host):

- `tools-lib/_index.json` maps host patterns → tool files.
- Bundled profiles: `github.com.json`, `news.ycombinator.com.json`, plus a `generic.json` fallback.
- User-saved profiles (via `/save_site_profile`) live in `chrome.storage.local`
  under `site_profiles[host]` and take precedence over bundled ones.

## The agent flow

1. User clicks the toolbar icon → popup opens.
2. User clicks **Connect this tab** → background opens the WS, registers the
   tools (base + site profile), mints a paste link.
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

## End-to-end test

The E2E test launches Chromium (Playwright's build) under Xvfb with the
extension loaded, runs a tiny `wrangler dev` instance for the relay, serves a
local test page, and verifies all the tools by hitting the agent token URL
exactly like an external AI chat would.

```bash
# Requires xvfb-run (sudo apt install xvfb).
xvfb-run -a -s "-screen 0 1280x900x24" \
  node chrome-extension/test/e2e.mjs
```

25 scenarios cover: connect/mint, meta endpoints, page info, eval (success/error/await),
DOM query, click/fill/submit, wait_for, scroll, text/html, dynamic lists, tabs,
screenshot, save_site_profile, reconnect-loads-saved, and the negative paths.

## Architecture in one paragraph

`background.js` is an ES-module service worker. On `connect`, it instantiates
`lib/as-client.js` (a slim agent-socket client speaking the same WS frame
protocol as `@agent-socket/sdk`), registers a toolset built from
`lib/tools-base.js` (universal) plus the site profile (if any), and mints an
agent token. Each tool's handler runs in the service worker and forwards work
into the page via `chrome.scripting.executeScript({ world: "MAIN", ... })`,
which has full access to page globals. Tool input is parsed from the JSON body
the relay forwards; output is whatever the handler returns. The popup
(`popup.html`) is a thin client that exchanges `chrome.runtime.sendMessage`
calls with the SW.
