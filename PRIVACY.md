# Privacy Policy — Agent Socket

**Effective date: 2026-10-05**

This privacy policy describes how the Agent Socket Chrome extension and its companion services, the relay (`agentsocket.dev`) and the tool registry (`registry.agentsocket.dev`), handle data.

## What Agent Socket is

Agent Socket lets the user expose one browser tab of their choosing as a set of HTTP tool endpoints, so an AI chat (such as Claude, ChatGPT, or Gemini) can read and interact with that tab. The extension does nothing until the user explicitly clicks "Connect this tab" in its popup. It has no access to any website at install time: Chrome asks the user to grant site access the first time they click Connect, and that access is used only for the one tab the user connects.

## What data is processed

When the user starts a session, the following data may flow from the user's browser through the relay (`agentsocket.dev`) to whichever AI chat the user pastes the session URL into:

- The URL, title, and content (HTML, text, screenshots) of the tab the user explicitly connected.
- Form values and user interactions the AI initiates via tool calls (clicks, fills, scrolls).
- The output of JavaScript the AI runs via the `/eval` tool, scoped to the connected tab.

This data is sent only in response to tool calls that arrive on the user's one-time session URL.

## What we do NOT collect

- We do not collect analytics or telemetry from the extension. The extension makes no network requests except the relay connection for the active session and the tool-registry requests described below.
- We do not collect personal information about the user (name, email, payment information, location, contacts).
- We do not track usage across sessions or across users.
- We do not collect data from tabs the user has not explicitly connected. Tool calls can only act on the connected tab; a screenshot is refused unless that tab is the visible tab of its window.

## Where the data goes

1. **Browser → Relay (`agentsocket.dev`)**: Tool-call payloads travel over a WebSocket from the extension to the relay. The relay is a Cloudflare Worker with one Durable Object per session that holds the WebSocket open and forwards messages. It does not store tool-call payloads (no database, no logs in production), except the result of a long-running ("async") tool call, kept until the AI fetches it or the session ends. It does store the session's setup, as described under "How long data is retained".
2. **Relay → AI chat**: The relay forwards tool-call results to whoever is holding the user's session URL — by design, the AI chat the user pasted the URL into. What that AI chat does with the data is governed by the AI chat's own privacy policy (e.g. Anthropic's, OpenAI's, Google's).

## Tool registry (`registry.agentsocket.dev`)

The registry is a public catalog of "site profiles": notes and ready-made tools for particular websites, so the AI doesn't have to work out each site from scratch. The extension uses it in these ways:

- **On Connect**, the extension sends the connected tab's **hostname** (for example `github.com`; not the path, query, port, page title or page content) to the registry to fetch that site's profile. If the registry has none, a second request fetches the generic profile. Hostnames that can't be public sites (IP addresses, `localhost`, names ending in `.local`, `.lan`, `.internal`, `.localhost` or `.home.arpa`) are never sent; for those tabs only the generic profile is fetched. These requests carry no cookies or identifiers of ours, but like any web request they reach the server with the user's IP address and the browser's user agent. The registry keeps a per-site count of how often each profile is fetched (not per user). If the registry can't be reached within 3 seconds, the tab connects without it.
- **When the AI uses the registry tools**: `/registry_search` sends the AI's search text and `/registry_get` sends the hostname it asks about.
- **When the AI submits a profile** with `/registry_submit`, the extension sends the profile the AI wrote (a hostname, notes, and tool names, descriptions, input schemas and JavaScript code) and the extension's version number; the browser adds its user agent. The AI can submit without a separate confirmation from the user, so a submission may describe the site the user connected. The registry stores the submission with the user agent (truncated to 512 characters) and a keyed hash (HMAC-SHA-256 with a server-side secret) of the IP address, used only to rate-limit submissions; the IP address itself is not stored. Submissions are kept as the review history. Nothing goes live until a maintainer approves it; approved profiles are published to everyone.

The registry runs on Cloudflare Workers with Cloudflare's request logging turned on, so requests (including the hostname in the request URL) also appear in the operator's Cloudflare logs for Cloudflare's log-retention period. The registry URL can be changed in the extension's Settings (for example to a self-hosted registry), in which case these requests go there instead.

## How long data is retained

- **Relay**: While a session lasts, the relay keeps its setup in Cloudflare Durable Object storage: the tool names, descriptions and input schemas, the session's agents.md (which names the connected site's host and includes the notes of its site profile), for each session URL a hash of its token and an encrypted copy of it, a value derived from the reconnect secret (not the secret itself), and the results of long-running tool calls until the AI fetches them. When the user clicks Stop or closes the tab, the session and everything stored for it are deleted at once and any in-flight tool calls fail. If the connection drops unexpectedly (network loss, laptop sleep, Chrome restarting the extension's background worker), in-flight tool calls fail and the relay keeps the session for up to 24 hours so the extension can reconnect with the same session URL; meanwhile the session URL still returns the session's agents.md and tool list, and tool calls are refused. If the extension doesn't reconnect within 24 hours, the session and its stored data are deleted. Nothing is kept after the session ends.
- **Extension**: Before the user clicks Connect, the extension stores nothing. Afterwards it keeps, on the user's machine only:
  - in `chrome.storage.local`: (a) the relay and registry base URLs, if the user changed them in Settings, (b) where the user dragged the "AI has access" indicator, and (c) site profiles the AI saved with the `/save_site_profile` tool: first as *pending* (shown in the popup with Keep / Discard; pending profiles never run), then as *kept* once the user clicks Keep (deletable from the popup's Settings);
  - in `chrome.storage.session` (held in memory, cleared when Chrome exits, not readable by web pages or content scripts) while a tab is connected: the id of the connected tab, the relay base URL, the session id, the session URL and token, a random reconnect secret the relay issued for the session, the registry profile fetched for the tab, and, if the session URL had to be replaced after a lost connection, why and when (so the "link changed" notice survives a worker restart until the user copies the new URL). This lets a restarted extension background worker reconnect to the same session with the same tools, so the session URL the user pasted keeps working. While the relay can't be reached it is kept, so the extension can keep trying. It is removed on Disconnect or when the connected tab closes, and replaced when the relay starts a new session.

  The session URL, token and reconnect secret are discarded on disconnect. None of this is transmitted except the relay base URL, which decides where the session connects, the session id and reconnect secret, which go only to that relay when reconnecting, and the tools of kept profiles, which are registered with the relay (tool names, descriptions and input schemas, and the notes in the session's agents.md; the code stays in the extension) for sessions on that site. Uninstalling the extension deletes all of it.

## Third parties

We do not sell, rent, or share user data with third parties for advertising, marketing, or any other purpose unrelated to making the active session work. The relay and the registry are hosted on Cloudflare Workers; Cloudflare's data-handling practices are governed by its own privacy policy at <https://www.cloudflare.com/privacypolicy/>.

## User control

- While a tab is connected it shows an "AI has access to this tab" bar with a Stop button and an "AI" badge on the extension icon. If the session URL had to be replaced (the connection was lost for longer than the relay keeps it), the bar, the badge ("NEW") and the popup say so until the user copies the new URL. Stop (in the bar or the popup's "Stop & disconnect") or closing the tab terminates the session and invalidates the session URL at once (if the relay can't be reached at that moment, within 24 hours). If Chrome quits or crashes instead, the extension can't reconnect to the session (its reconnect secret was held in memory only); the relay deletes the session within 24 hours, and until then the session URL returns the session's agents.md and tool list but no tool call reaches the browser.
- The session URL is the only authorization token.
- Tools the AI saves for a site never run until the user clicks Keep in the popup, which also shows their code for review; kept profiles can be deleted at any time.
- The user can revoke the extension's site access or remove it at any time from `chrome://extensions`.
- The `chrome.userScripts` API used by the `/eval` tool is additionally gated behind a per-extension "Allow User Scripts" toggle that the user must explicitly enable.
- Source code for both the extension and the relay is open and auditable: <https://github.com/blitzdotdev/agent-socket>.

## Changes to this policy

If we change this policy, we will update the Effective date above and publish the change in the same repository.

## Contact

Questions about this policy: open an issue at <https://github.com/blitzdotdev/agent-socket/issues> or email contact@agentsocket.dev.
