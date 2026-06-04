# Privacy Policy — Agent Socket

**Effective date: 2026-06-02**

This privacy policy describes how the Agent Socket Chrome extension and its companion relay service (`agentsocket.dev`) handle data.

## What Agent Socket is

Agent Socket lets the user expose the currently-active browser tab as a set of HTTP tool endpoints, so an AI chat (such as Claude, ChatGPT, or Gemini) can read and interact with that tab. The extension does nothing until the user explicitly clicks "Connect this tab" in its popup.

## What data is processed

When the user starts a session, the following data may flow from the user's browser through the relay (`agentsocket.dev`) to whichever AI chat the user pastes the session URL into:

- The URL, title, and content (HTML, text, screenshots) of the tab the user explicitly connected.
- Form values and user interactions the AI initiates via tool calls (clicks, fills, scrolls).
- Console messages from the connected tab.
- The output of JavaScript the AI runs via the `/eval` tool, scoped to the connected tab.

This data is sent only in response to tool calls that arrive on the user's one-time session URL.

## What we do NOT collect

- We do not collect analytics or telemetry from the extension. The extension makes no network requests except those required for the active session.
- We do not collect personal information about the user (name, email, payment information, location, contacts).
- We do not track usage across sessions or across users.
- We do not collect data from tabs the user has not explicitly connected.

## Where the data goes

1. **Browser → Relay (`agentsocket.dev`)**: Tool-call payloads travel over a WebSocket from the extension to the relay. The relay is a stateless Cloudflare Worker (Durable Object) that holds the WebSocket open and forwards messages. It does not write the payloads to any persistent storage (no database, no logs in production).
2. **Relay → AI chat**: The relay forwards tool-call results to whoever is holding the user's session URL — by design, the AI chat the user pasted the URL into. What that AI chat does with the data is governed by the AI chat's own privacy policy (e.g. Anthropic's, OpenAI's, Google's).

## How long data is retained

- **Relay**: Sessions live in memory only while the user's tab is connected. When the user clicks Disconnect, closes the tab, or the WebSocket drops, the session is destroyed and any in-flight tool calls fail. Nothing persists across the session.
- **Extension (`chrome.storage.local`)**: The extension stores only two things locally on the user's machine — (a) the relay base URL setting, and (b) site-specific tool profiles the user has saved via the `/save_site_profile` tool. Neither is transmitted off the user's machine. The user can delete these by uninstalling the extension or clearing extension storage from `chrome://extensions`.

## Third parties

We do not sell, rent, or share user data with third parties for advertising, marketing, or any other purpose unrelated to making the active session work. The relay is hosted on Cloudflare Workers; Cloudflare's data-handling practices are governed by its own privacy policy at <https://www.cloudflare.com/privacypolicy/>.

## User control

- The session URL is the only authorization token. Disconnecting from the popup, closing the tab, or restarting Chrome terminates the session.
- The user can revoke the extension's access at any time from `chrome://extensions`.
- The `chrome.userScripts` API used by the `/eval` tool is additionally gated behind a per-extension "Allow User Scripts" toggle that the user must explicitly enable.
- Source code for both the extension and the relay is open and auditable: <https://github.com/pythonlearner1025/agent-socket>.

## Changes to this policy

If we change this policy, we will update the Effective date above and publish the change in the same repository.

## Contact

Questions about this policy: open an issue at <https://github.com/pythonlearner1025/agent-socket/issues> or email mjsong2021@gmail.com.
