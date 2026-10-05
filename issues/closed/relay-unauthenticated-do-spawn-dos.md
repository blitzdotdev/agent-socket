# relay: unauthenticated WS upgrade spawns a non-hibernating Durable Object per connection — DoS / cost amplifier

## What's wrong

Every WebSocket upgrade to `/v1/_ws` (`relay/src/worker.ts:72-93`) — with no credential of any kind — mints a fresh session-id and **spawns a new Durable Object**:

```ts
sessionId = generateSessionId()
const id = env.RELAY.idFromName(sessionId)
const fwd = new Request(req.url, req)
fwd.headers.set("x-as-session-id", sessionId)
return env.RELAY.get(id).fetch(fwd)
```

Each spawned `RelayServer` runs with `static options = { hibernate: false }` (`relay-do.ts:70`), so its isolate is pinned in memory until Cloudflare evicts it (~70–140 s per the `onClose` comment), even if the client never sends `register` and just sits idle after the upgrade.

There is no per-IP connection limit, no global cap, no proof-of-work, and no auth on the upgrade.

## Why it matters

An unauthenticated attacker can open a large number of WS connections (or upgrade-and-idle), each pinning a non-hibernating DO isolate plus its in-memory `RelayServer` state. The existing limits — `MAX_TOKENS_PER_SESSION`, `MAX_TASKS_PER_SESSION`, `MAX_INFLIGHT` — are all **per-session** and do nothing to stop *spawning sessions*. This is a classic cheap resource-exhaustion / cost-amplification vector against a public deploy.

(The `SECURITY.md` already acknowledges "no per-IP rate limiting on `/v1/_ws`" as a known v0 limitation, and a CF-dashboard rate-limit was noted as a manual step — this issue records the concrete mechanism so it isn't lost, and notes the `hibernate: false` interaction that makes idle pre-register connections more expensive than they need to be.)

## What to do

- Add a per-IP connection / session-creation rate limit (Cloudflare WAF rate-limiting rule or a rate-limiting binding) in front of `/v1/_ws`.
- Consider enabling WS hibernation for connections that haven't completed `register`, so idle pre-register connections don't pin an isolate.
- Optionally require a minimal challenge (or a registered app-id token) before allocating a DO.

## Acceptance

- A burst of unauthenticated WS upgrades from one source is rate-limited rather than each spawning a pinned DO.
- Idle-after-upgrade connections do not hold a non-hibernating isolate indefinitely.

## Provenance

Found during a full line-by-line audit. Verified the upgrade path (`worker.ts:72-93`) spawns a DO with no auth, and `hibernate: false` (`relay-do.ts:70`). Recorded as MEDIUM: real for a public deploy, partially covered by the noted manual CF rate-limit step, but the `hibernate: false` pre-register angle is worth fixing in code.

**CLOSED 2026-10-05.** `/v1/_ws` upgrades are rate-limited per IP with a Workers Rate Limiting binding (`WS_RATE_LIMIT`, 60 per 10 s, 429 `rate_limited`), and the DO closes a socket that hasn't registered within 10 s (4408). Harness: `48-register-timeout`, `90-ws-rate-limit`.
