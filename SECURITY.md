# Security policy

## Reporting a vulnerability

Report it privately through GitHub: <https://github.com/blitzdotdev/agent-socket/security/advisories/new>. Please don't open a public issue.

Include the affected component (relay, SDK, Chrome extension, registry), steps or code to reproduce, and what an attacker gains. We aim to acknowledge within 72 hours and to give a first assessment within 7 days. Reporters are credited in the published advisory unless they prefer not to be.

## Scope

- The relay at agentsocket.dev and any deployment of `relay/`.
- `@agent-socket/sdk` (`sdk/`).
- The Chrome extension (`chrome-extension/`).
- The registry at registry.agentsocket.dev and any deployment of `registry/`.

## How it is meant to work

The protocol and threat model are in [docs/protocol.md](docs/protocol.md). In short:

- **An agent link is a bearer credential.** Anyone who has it can call every tool in that session until the link is revoked or the session ends. There is no other authentication.
- **The session id is public.** It is part of every link. Calling tools needs the link's 128-bit verifier; taking over the app side of a session needs the 256-bit resume secret, which only the app receives and which is compared in constant time.
- **App ids are unchecked labels.** Any app can register under any app id. The relay does not check `Origin`.
- **The relay holds everything in memory.** A dropped app's session is kept for 60 s so it can resume, then wiped; a clean close wipes it at once. Nothing is written to storage.
- **The relay sees tool calls and replies in plaintext** after TLS, while it forwards them.
- **Tool output is untrusted input for the AI**, and agent input is untrusted input for the app.
- **The extension gives the link holder the tab.** `/eval` runs any JavaScript in the bound tab, with the user's logged-in session on that site. The `/navigate` check for local and private-network hosts is a guardrail, not a boundary, because `/eval` can navigate too. Only the bound tab is reachable, and Stop, disconnecting or closing the tab ends access.

Reports that only restate these properties are not treated as vulnerabilities.

## Limits

| | |
|---|---|
| Agent request body | 1 MiB (`413 body_too_large`) |
| App WebSocket frame | 4 MiB (close 1009) |
| `agentsMd` | 65,536 characters |
| Links per session | 50 |
| Tool calls in flight per session | 100 (`429 too_many_inflight`) |
| Pending async tasks per session | 100, result body 64 KiB |
| Sync tool timeout | 30 s (`504 tool_timeout`) |
| Register or resume deadline | 10 s (close 4408) |
| App liveness timeout | 50 s |
| Pending resume sockets per session | 4 |
| `/v1/_ws` upgrades | 100 per 10 s per IP, counted per Cloudflare location (`429 rate_limited`) |

There is no global cap on sessions beyond the per-IP rate limit.

## Protections in place

- **CSRF.** A tool call carrying a `Sec-Fetch-Site` header other than `none` (a request from a web page) gets `403 csrf_denied`. `agents.md`, `tools.json` and task polls are read-only and exempt. Not covered: Safari before 16.4, which omits the header, and browser-extension service workers, which send `none`.
- **Response sandboxing.** App responses are served from the relay's origin with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`, and HTML, SVG and XML content types are downgraded to `text/plain`.
- **No socket takeover through agent URLs.** WebSocket upgrades are only accepted on `/v1/_ws`. A socket on `/v1/_ws?session=<id>` can do nothing until it presents the resume secret.
- **Agent IPs are not forwarded** to the app (`x-real-ip` and `x-forwarded-*` are stripped).
- **Debug endpoints** exist only when `DEBUG=1`, which production never sets.
- **Registry admin** requires Cloudflare Access, and the Worker verifies the Access JWT on every admin request. Submissions never go live without an admin approving them.

## What we would treat as a vulnerability

- Calling tools without a valid, unrevoked link, or reaching another session's tools or data.
- Resuming or disturbing a session's app socket without its resume secret.
- Script execution on the relay's origin through app-supplied content.
- Memory exhaustion or session disruption beyond the limits above.
- The extension acting on a tab other than the bound one, or after the session ended.
- Bypassing registry review or admin authentication.
