# Privacy Policy — Agent Socket

**Effective date: 2026-10-05**

This privacy policy describes how the Agent Socket Chrome extension and its companion relay service (`agentsocket.dev`) handle data.

## What Agent Socket is

Agent Socket lets the user expose one browser tab of their choosing as a set of HTTP tool endpoints, so an AI chat (such as Claude, ChatGPT, or Gemini) can read and interact with that tab. The extension does nothing until the user explicitly clicks "Connect this tab" in its popup. It has no access to any website at install time: Chrome asks the user to grant site access the first time they click Connect, and that access is used only for the one tab the user connects.

## What data is processed

When the user starts a session, the following data may flow from the user's browser through the relay (`agentsocket.dev`) to whichever AI chat the user pastes the session URL into:

- The URL, title, and content (HTML, text, screenshots) of the tab the user explicitly connected.
- Form values and user interactions the AI initiates via tool calls (clicks, fills, scrolls).
- The output of JavaScript the AI runs via the `/eval` tool, scoped to the connected tab.

This data is sent only in response to tool calls that arrive on the user's one-time session URL.

## What we do NOT collect

- We do not collect analytics or telemetry from the extension. The extension makes no network requests except those required for the active session.
- We do not collect personal information about the user (name, email, payment information, location, contacts).
- We do not track usage across sessions or across users.
- We do not collect data from tabs the user has not explicitly connected. Tool calls can only act on the connected tab; a screenshot is refused unless that tab is the visible tab of its window.

## Where the data goes

1. **Browser → Relay (`agentsocket.dev`)**: Tool-call payloads travel over a WebSocket from the extension to the relay. The relay is a stateless Cloudflare Worker (Durable Object) that holds the WebSocket open and forwards messages. It does not write the payloads to any persistent storage (no database, no logs in production).
2. **Relay → AI chat**: The relay forwards tool-call results to whoever is holding the user's session URL — by design, the AI chat the user pasted the URL into. What that AI chat does with the data is governed by the AI chat's own privacy policy (e.g. Anthropic's, OpenAI's, Google's).

## How long data is retained

- **Relay**: Sessions live in memory only. When the user clicks Disconnect or closes the tab, the session is destroyed and any in-flight tool calls fail. If the WebSocket drops unexpectedly (a network blip, or Chrome restarting the extension's background worker), in-flight tool calls fail and the relay keeps the session's registration and session URL valid in memory for up to 60 seconds so the extension can reconnect to it; tool calls arriving in that window are refused, and if the extension doesn't reconnect the session is destroyed. Nothing persists across the session.
- **Extension**: Before the user clicks Connect, the extension stores nothing. Afterwards it keeps, on the user's machine only:
  - in `chrome.storage.local`: (a) the relay base URL, if the user changed it in Settings, and (b) site-specific tool profiles saved via the `/save_site_profile` tool (deletable from the popup's Settings);
  - in `chrome.storage.session` (held in memory, cleared when Chrome exits, not readable by web pages or content scripts) while a tab is connected: the id of the connected tab, the relay base URL, the session id, the session URL and token, and a random reconnect secret the relay issued for the session. This lets a restarted extension background worker reconnect to the same session, so the session URL the user pasted keeps working. It is removed on Disconnect, when the connected tab closes, or when reconnecting fails.

  The session URL, token and reconnect secret are discarded on disconnect. None of this is transmitted except the relay base URL, which decides where the session connects, and the session id and reconnect secret, which go only to that relay when reconnecting. Uninstalling the extension deletes all of it.

## Third parties

We do not sell, rent, or share user data with third parties for advertising, marketing, or any other purpose unrelated to making the active session work. The relay is hosted on Cloudflare Workers; Cloudflare's data-handling practices are governed by its own privacy policy at <https://www.cloudflare.com/privacypolicy/>.

## User control

- While a tab is connected it shows an "AI has access to this tab" bar with a Stop button and an "AI" badge on the extension icon. Stop (in the bar or the popup's "Stop & disconnect") or closing the tab terminates the session and invalidates the session URL at once; restarting Chrome does so within 60 seconds.
- The session URL is the only authorization token.
- The user can revoke the extension's site access or remove it at any time from `chrome://extensions`.
- The `chrome.userScripts` API used by the `/eval` tool is additionally gated behind a per-extension "Allow User Scripts" toggle that the user must explicitly enable.
- Source code for both the extension and the relay is open and auditable: <https://github.com/blitzdotdev/agent-socket>.

## Changes to this policy

If we change this policy, we will update the Effective date above and publish the change in the same repository.

## Contact

Questions about this policy: open an issue at <https://github.com/blitzdotdev/agent-socket/issues> or email mjsong2021@gmail.com.
