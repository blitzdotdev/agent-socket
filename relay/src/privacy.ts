// Static privacy policy page served at /privacy on agentsocket.dev.
// The Chrome Web Store requires a publicly-reachable dedicated privacy-policy
// URL for the extension. This page satisfies that requirement.

export const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy — Agent Socket</title>
  <style>
    body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 720px; margin: 2.5rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.15rem; margin-top: 2rem; }
    p, ul, ol { margin: 0.75rem 0; }
    code { background: #f4f4f5; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
    a { color: #0a66c2; }
    .effective { color: #555; font-size: 0.95rem; margin-bottom: 1.5rem; }
    hr { border: none; border-top: 1px solid #e5e5e5; margin: 2rem 0; }
  </style>
</head>
<body>
  <h1>Privacy Policy — Agent Socket</h1>
  <p class="effective">Effective date: 2026-06-02</p>

  <p>This privacy policy describes how the Agent Socket Chrome extension and its companion relay service (<code>agentsocket.dev</code>) handle data.</p>

  <h2>What Agent Socket is</h2>
  <p>Agent Socket lets the user expose the currently-active browser tab as a set of HTTP tool endpoints, so an AI chat (such as Claude, ChatGPT, or Gemini) can read and interact with that tab. The extension does nothing until the user explicitly clicks "Connect this tab" in its popup.</p>

  <h2>What data is processed</h2>
  <p>When the user starts a session, the following data may flow from the user's browser through the relay (<code>agentsocket.dev</code>) to whichever AI chat the user pastes the session URL into:</p>
  <ul>
    <li>The URL, title, and content (HTML, text, screenshots) of the tab the user explicitly connected.</li>
    <li>Form values and user interactions the AI initiates via tool calls (clicks, fills, scrolls).</li>
    <li>Console messages from the connected tab.</li>
    <li>The output of JavaScript the AI runs via the <code>/eval</code> tool, scoped to the connected tab.</li>
  </ul>
  <p>This data is sent only in response to tool calls that arrive on the user's one-time session URL.</p>

  <h2>What we do NOT collect</h2>
  <ul>
    <li>We do not collect analytics or telemetry from the extension. The extension makes no network requests except those required for the active session.</li>
    <li>We do not collect personal information about the user (name, email, payment information, location, contacts).</li>
    <li>We do not track usage across sessions or across users.</li>
    <li>We do not collect data from tabs the user has not explicitly connected.</li>
  </ul>

  <h2>Where the data goes</h2>
  <ol>
    <li><strong>Browser → Relay (<code>agentsocket.dev</code>):</strong> Tool-call payloads travel over a WebSocket from the extension to the relay. The relay is a stateless Cloudflare Worker (Durable Object) that holds the WebSocket open and forwards messages. It does not write the payloads to any persistent storage (no database, no logs in production).</li>
    <li><strong>Relay → AI chat:</strong> The relay forwards tool-call results to whoever is holding the user's session URL — by design, the AI chat the user pasted the URL into. What that AI chat does with the data is governed by the AI chat's own privacy policy (e.g. Anthropic's, OpenAI's, Google's).</li>
  </ol>

  <h2>How long data is retained</h2>
  <ul>
    <li><strong>Relay:</strong> Sessions live in memory only while the user's tab is connected. When the user clicks Disconnect, closes the tab, or the WebSocket drops, the session is destroyed and any in-flight tool calls fail. Nothing persists across the session.</li>
    <li><strong>Extension (<code>chrome.storage.local</code>):</strong> The extension stores only two things locally on the user's machine — (a) the relay base URL setting, and (b) site-specific tool profiles the user has saved via the <code>/save_site_profile</code> tool. Neither is transmitted off the user's machine. The user can delete these by uninstalling the extension or clearing extension storage from <code>chrome://extensions</code>.</li>
  </ul>

  <h2>Third parties</h2>
  <p>We do not sell, rent, or share user data with third parties for advertising, marketing, or any other purpose unrelated to making the active session work. The relay is hosted on Cloudflare Workers; Cloudflare's data-handling practices are governed by its own privacy policy at <a href="https://www.cloudflare.com/privacypolicy/">https://www.cloudflare.com/privacypolicy/</a>.</p>

  <h2>User control</h2>
  <ul>
    <li>The session URL is the only authorization token. Disconnecting from the popup, closing the tab, or restarting Chrome terminates the session.</li>
    <li>The user can revoke the extension's access at any time from <code>chrome://extensions</code>.</li>
    <li>The <code>chrome.userScripts</code> API used by the <code>/eval</code> tool is additionally gated behind a per-extension "Allow User Scripts" toggle that the user must explicitly enable.</li>
    <li>Source code for both the extension and the relay is open and auditable: <a href="https://github.com/pythonlearner1025/agent-socket">github.com/pythonlearner1025/agent-socket</a>.</li>
  </ul>

  <h2>Changes to this policy</h2>
  <p>If we change this policy, we will update the Effective date above and publish the change in the same repository.</p>

  <h2>Contact</h2>
  <p>Questions about this policy: open an issue at <a href="https://github.com/pythonlearner1025/agent-socket/issues">github.com/pythonlearner1025/agent-socket/issues</a> or email <a href="mailto:mjsong2021@gmail.com">mjsong2021@gmail.com</a>.</p>
</body>
</html>`
