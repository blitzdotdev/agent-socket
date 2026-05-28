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

## Credit

Researchers who report responsibly will be credited in [`ACKNOWLEDGMENTS.md`](ACKNOWLEDGMENTS.md) unless they prefer to remain anonymous.
