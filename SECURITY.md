# Security Policy

## Supported versions

agent-socket is v0 and explicitly **not production-grade**. All released versions are "supported" in the sense that I'll look at reported issues, but there are no LTS guarantees.

## Reporting a vulnerability

**Don't open a public GitHub issue for a security report.**

Email security disclosures to the maintainers via the contact listed on the [teenybase GitHub org](https://github.com/teenybase) page, with subject line starting `[agent-socket security]`.

Please include:

- The component affected (relay / SDK / CLI / chrome extension)
- A reproduction (curl command, code sample, or steps to trigger)
- Your assessment of impact (data exposure / DoS / RCE / etc.)
- Whether you've discussed the issue publicly already

Acknowledgement target: 72 hours. Initial assessment target: 7 days. We'll keep you posted on remediation timeline.

## What's in scope

- **The relay at `agentsocket.dev` / `aisocket.dev`** (and self-hosted deployments running the same Worker code from this repo).
- **The SDK, CLI, and chrome extension code** in this repo.
- **The protocol** between agents / apps / channel participants.

Anything outside `relay/`, `sdk/`, `cli/`, `chrome-extension/` is out of scope.

## Known v0 trust-model limitations

These are **by design** for v0, documented in the spec, and not considered vulnerabilities:

- **No authentication.** The agent-token URL is the only secret. Anyone with it can read and post. Treat URLs as DM-grade secrets.
- **Anyone can claim any name** in the channel CLI. Names are self-assigned labels; there's no identity verification.
- **No per-IP rate limiting** on `/v1/_ws` upgrade. Per-session limits (10 inflight, 50 tokens) only. A motivated abuser can spin up arbitrary sessions.
- **`apps.json` is hardcoded** at deploy time. Third-party app-id registration requires editing the file and redeploying.
- **No persistence.** DOs die on disconnect; channel host RAM is the only state.
- **Channel content is untrusted input.** AI participants must treat messages as data, not directives. See [`docs/spec/`](docs/) §9.5.

Reports about these specific behaviors will be acknowledged but won't be treated as vulnerabilities unless they reveal an attack vector beyond what the model already admits.

## What we'd consider a vulnerability

- Bypassing the in-memory token check (impersonating a session you don't have the verifier for)
- Leaking DO state across sessions
- Cross-session data exposure via the relay
- Memory-exhaustion vectors beyond the documented 10-inflight / 50-token / 1000-msg caps
- DEBUG endpoints accessible in production (would be a misconfiguration / deploy regression)
- Bypassing the chrome extension's per-tab activation gate
- Cross-origin token leakage from a registered app-id with strict allowed-origins
- Anything that lets a remote party run code on the host machine via the chrome extension or CLI beyond what the user explicitly approved

## Mitigations in place

- **CSRF on the user-tool surface.** User-defined tool endpoints (`/v1/t/<token>/<tool-path>`) run handler code and may have side effects, so a browser-initiated cross-site request to one is treated as a CSRF attempt. The relay returns HTTP 403 / `csrf_denied` when the request carries a `Sec-Fetch-Site` header set to anything other than `none`. `Sec-Fetch-Site` is a Forbidden Header — modern browsers attach it on every fetch and page JavaScript cannot set, override, or strip it. Non-browser HTTP clients (curl, Node `fetch`, Python `requests`, Anthropic/OpenAI server-side fetchers) don't send the header, so legitimate AI-runtime traffic passes through. The `none` value is only sent on user-initiated top-level navigation (address-bar paste, bookmark, link from a desktop app / terminal), which we keep working.

  Read-only meta paths — `GET /v1/t/<token>/agents.md`, `GET /v1/t/<token>/tools.json`, `GET /v1/t/<token>/_as_tasks/<id>` — bypass the CSRF gate. They're served directly by the relay (no user code), have no side effects, and clicking the URL from Gmail / web chat to "preview what this URL is" sends `Sec-Fetch-Site: cross-site`, which we deliberately allow on these three paths.

  Known false negatives (CSRF requests that slip past): Safari < 16.4 omits `Sec-Fetch-Site` entirely (mostly aged out by 2026); Chrome MV3 extension service-worker fetches send `Sec-Fetch-Site: none` (out of scope — a malicious extension can already do far more than CSRF); and an on-path network attacker can strip the header (requires TLS to be broken, which is a bigger problem).

  The WebSocket app surface (`/v1/_ws`) is intentionally unaffected — apps may legitimately be browsers (chrome extension, in-browser SDK users), and origin trust is gated by `apps.json`. The landing page (`GET /`) is also unaffected — humans visit it from search results and link previews.

## Credit

Researchers who report responsibly will be credited in [`ACKNOWLEDGMENTS.md`](ACKNOWLEDGMENTS.md) unless they prefer to remain anonymous.
