# tool-relay: ship a first-class blocking-event-receive primitive (so agents stop hand-rolling poll loops) + related reliability/DX fixes

## Summary

An agent that drives an app through the **tool-relay** model (SDK `register` + handlers on the host; the agent is a plain HTTP/curl client with no SDK on its side) has no way to *block* waiting for an event. To stay reachable it must poll the app's long-poll tool (e.g. `GET $BASE/events?since=&wait=`) and **re-issue that request itself, forever**. For an LLM agent each empty poll is roughly one model turn, so an idle agent burns turns just to stay alive (at a 25s wait that is ~144 turns/hr at idle, and the figure scales with how short the wait is forced to be).

The relay already proves the right shape twice over: the **channel** model has a real blocking-recv (`channel recv --wait` / `channel watch` over `fs.watch` on a local `log.jsonl`), and the host↔relay leg is a push WebSocket. But the **tool-relay** agent leg is unidirectional HTTPS with no server-side wait/wakeup and no push. BlitzOS papered over this with a per-app `wait.sh` shell loop — a per-app reinvention this issue should obviate.

This issue collects five related findings. The headline ask is **(1) a first-class blocking-event-receive primitive for tool-relay agents**; the other four are the reliability/DX problems that make the poll loop necessary or fragile in the first place.

---

## Finding 1 — No blocking-recv primitive for tool-relay agents (the core ask)

### Problem
In the tool-relay model the agent is a plain HTTP client. Tools are stateless request/response: a `tool_call` frame in, one `tool_reply` frame out. There is no server-side waiter list, no wakeup, no push to the agent — so "receive an event" can only be expressed as "the agent re-issues a long-poll tool call." The SDK exposes nothing else:

- `sdk/src/types.ts:21-26` — `ToolCallContext` is a read-only `{ method, path, body, headers }`; no streaming/subscription context.
- `sdk/src/types.ts:28-47` — `ToolResult` is a single value/`{status, body, taskId, headers}` union; a handler returns once (`ToolHandler` at line 47). `sdk/src/session.ts:443-449` normalizes that single result.
- `sdk/src/session.ts:252-296` — `_handleToolCall` consumes one `tool_call` frame and returns one `tool_reply` frame. No event stream, no push.
- `sdk/README.md:83-104` — async tools return `202 + taskId`; the agent then **polls** `GET /_as_tasks/<taskId>`. Polling is the only model-level pattern for "wait for something."
- `relay/README.md:13` — the relay owns a "pending-request map: each agent's HTTPS call … matched by `id` → resolve." There is no bidirectional waiter list on the tool-relay path; the channel `/recv` blocking is a **channel-only** feature, not a general tool-model feature.

### Why it matters
Every app that wants an agent to react to events has to reinvent client-side polling, and an LLM agent pays a model turn per empty poll. At idle that is pure waste and keeps the agent "busy" doing nothing. It also makes "stay reachable" framing necessary in agent instructions (see Finding 4), which itself causes problems.

### Proposed direction
Add a first-class blocking-event-receive to the tool-relay model so apps don't each ship a `wait.sh`. Two shapes, not mutually exclusive:

- **Server-side wait/wakeup on the tool path.** Generalize the channel `LogStore.wait()` waiter mechanism (see Prior art below) into the SDK tool model: a handler can register a per-key waiter that the relay holds open and resolves on the next matching event, rather than returning immediately. The agent issues *one* call and the relay holds it until there's something to deliver (bounded by the per-request hold cap — Finding 2).
- **A canonical "wait" helper** so app authors don't hand-roll the long-poll-and-re-issue dance. TBD: confirm exact API surface (SDK helper vs. relay-native endpoint).

---

## Finding 2 — Per-request hold cap is short (30s), forcing tiny waits and many round-trips

### Problem
The relay holds the agent's HTTPS request open while the host computes the reply, bounded by a per-request timer:

- `relay/src/relay-do.ts:548-584` — a `tool_call` is held by a `PendingRequest` (`Promise` + `setTimeout`) until a `tool_reply` arrives or the timer fires with `tool_timeout` (`504`).
- `relay/src/relay-do.ts:556` — `const timeoutMs = parseInt(this.env.MAX_SYNC_TOOL_MS || "30000", 10)`. Default **30000 ms (30 s)**, from env `MAX_SYNC_TOOL_MS` (`relay/wrangler.jsonc:30: "MAX_SYNC_TOOL_MS": "30000"`).

Because of this cap, apps keep the agent's long-poll wait short — BlitzOS uses `wait:25s`, deliberately under the 30s cap. A short wait means the agent must re-issue the poll frequently, multiplying both round-trips and (for an LLM agent) model turns.

Crucially, the relay is a **Durable Object**, so it can hold a pending request far longer than a plain Worker — the 30s is an application-level choice, not a runtime limit:

- `relay/src/relay-do.ts:49-52` — `PendingRequest` (`resolve` + `timer`) persisted in the DO.
- `relay/src/relay-do.ts:108-114` — on WS close, `pending` is cleared with an error response, but DO lifetime is not otherwise constrained.
- `relay/src/relay-do.ts:345-352` — `handleToolReply` clears the timer and deletes the pending entry when the reply arrives.

### Why it matters
A longer hold means one long-poll can block for minutes instead of 25s, cutting round-trips and agent re-issues by an order of magnitude — directly reducing the model-turn waste in Finding 1.

### Proposed direction
- Document the cap and its source of truth (`MAX_SYNC_TOOL_MS`, `relay-do.ts:556`).
- Expose a longer and/or per-request-configurable hold (e.g. a `wait`/hold parameter clamped to a higher max), so a blocking-recv long-poll can legitimately hold for minutes within the DO. Confirm the safe upper bound against Cloudflare DO/edge limits before raising the default. TBD: confirm any edge/CDN-imposed ceiling on how long an in-flight HTTPS request can be held end-to-end (independent of the DO).

---

## Finding 3 — No true push to the agent (agent is HTTP-only)

### Problem
Transport is asymmetric. Host↔relay is a bidirectional WebSocket; agent↔relay is plain HTTPS with no push/subscribe:

- `README.md:6` diagram — `[your app] ──WS──▶ [agent-socket relay] ◀──HTTPS── [AI chat]`.
- `sdk/src/transport.ts:1-90` — WebSocket is the host-side transport only (`openWs()`).
- `preamble.ts:47-49` — the agent discovers tools via `GET $BASE/tools.json` and calls `<method> $BASE<path>`; HTTP only, no push.

So even when the agent is **co-located** with the host (the common BlitzOS case), it can't be pushed to — it polls. The channel model already shows the low-latency path for a co-located consumer: local-file `fs.watch` (see Prior art).

### Why it matters
For a co-located agent, polling is strictly worse than the file-watch the channel model already uses: higher latency on the event you care about, and turn-waste on the empties.

### Proposed direction
Give the tool-relay agent a real push path. Options:
- An agent-side SSE/WS subscription endpoint on the relay (the agent opens one long-lived stream and receives events pushed).
- Generalize the channel local-log model so a co-located tool-relay agent can `fs.watch` a local event log instead of polling the network (reuse `createResilientWatcher`).

TBD: confirm which fits the "agent is a plain curl client in a chat window" constraint — SSE is reachable from curl/chat agents; `fs.watch` only helps a co-located process.

---

## Finding 4 — Aggressive "stay reachable / never stop" agent framing trips cyber classifiers

### Problem
The polling model (Findings 1-3) pressures app authors to write aggressive bootstrap framing — "stay reachable / never stop / poll forever / or you go DEAF" — so the agent keeps re-issuing the long-poll. That phrasing reads like command-and-control (C2) and risks a cyber classifier flagging the agent. BlitzOS hit exactly this and **softened its bootstrap** in response.

Note: the SDK's *own* default is already neutral and is **not** the source of the aggressive framing:
- `sdk/src/agents-md.ts:27-55` — `defaultAgentsMd` emits neutral sections only: **"What you can do" / "What you cannot do" / "Conventions"**, with the default conventions string being just `"Read tools.json before any write."` (line 34). No polling/reachability language.
- `preamble.ts:11-15` — the preamble is explicitly "ADDITIVE CONTEXT, not a first-step directive."
- `preamble.ts:45` — "Do not recite this document back to the user—read it and act."

So the aggressive framing is something **app authors add on top** to compensate for the missing blocking-recv. Fixing Findings 1-3 removes the incentive to write it.

### Why it matters
A cyber-classifier flag on the agent can degrade or block the agent entirely. The framework should make the *neutral* phrasing also be the *effective* one, so authors aren't pushed toward C2-shaped instructions to keep an agent alive.

### Proposed direction
- Keep the SDK default neutral (it already is) and **document** that aggressive "stay reachable / poll forever" framing is both unnecessary (once blocking-recv exists) and risky (classifier exposure).
- Add a recommended, soft/neutral "how to wait for events" snippet to the agent-facing guidance that points at the blocking-recv primitive instead of a poll loop.
- TBD: confirm whether any shipped example/template (chrome-ext, agent-bridge) currently carries reachability framing that should be softened.

---

## Finding 5 — Relay reconnect storm mints a NEW URL/token each time → agent's baked URL goes stale

### Problem
When the host↔relay WS drops and reconnects, a **fresh session-id** is generated at the edge, which derives a **new DO instance** and **new tokens** — invalidating the agent's previously-baked paste URL:

- `relay/src/worker.ts:79-86` — each `/v1/_ws` connection runs `sessionId = generateSessionId()` then `id = env.RELAY.idFromName(sessionId)`; the session-id is randomly generated per connection at the edge.
- `relay/src/relay-do.ts:93-100` — the DO stores the incoming `x-as-session-id` as `this.sessionId`, so it changes with each new WS connection.
- `sdk/src/session.ts:340` — reconnect calls `_connectAndRegister()`, which opens a new WS to `/v1/_ws`, triggering a fresh `generateSessionId()`.
- `sdk/src/session.ts:359-367` — `_reconnectAndRemint()` then mints brand-new tokens for the new session: `const fresh = await this.mintAgentToken({ label: old.label })`.
- `relay/src/relay-do.ts:297` — mint derives the token from the current session: `makeAgentToken(this.env.TOKEN_PREFIX, this.sessionId, verifier)`.
- `relay/src/relay-do.ts:452-454` — old tokens then fail: `if (!parsed || parsed.sessionId !== this.sessionId) return errorResponse('token_invalid', 'token format or session mismatch', 401)`.
- `relay/src/relay-do.ts:88-92` — a second WS to the same DO is rejected (`close(4409, 'already connected')`), and each DO has its own `validTokens` map (`relay-do.ts:81`, set at line 306) — there's no token reuse across DO instances.

Net: every transient drop invalidates the agent's URL, forcing apps to do a relay-url-file self-heal + agent re-exec. BlitzOS has a parallel issue doc on exactly this stale-URL churn.

### Why it matters
The agent's URL is supposed to be a stable, paste-once credential. If it goes stale on every transient WS hiccup, every app must build URL-rotation plumbing (file self-heal, re-exec) just to survive a flaky connection — and any in-flight agent that already pasted the old URL silently 401s.

### Proposed direction
Make reconnection **sticky**: preserve the session-id (and therefore the DO instance, tokens, and URL) across transient drops, so a disconnect does not invalidate the agent's URL. Candidate approaches:
- Have the SDK persist its session-id and send it back on reconnect (`x-as-session-id`) so `idFromName` resolves the **same** DO, with the existing `4409 already connected` guard relaxed to allow takeover by the same client after the old WS is gone.
- Keep tokens valid across reconnects by anchoring them to a stable session identity rather than a per-connection random id.

Related: `sdk-reconnect-remint-race.md` (the remint loop itself can race mid-drop). Sticky reconnection would make most of that remint loop unnecessary.

---

## Prior art in this repo

The **channel** model already implements the exact blocking-recv primitive the tool-relay model lacks — it's proven, shipping, and "for Claude Code bg use":

- `cli/src/channel-recv.mjs:69-86` — `channel recv --wait` blocks via `tailUntil()` → `createResilientWatcher`, resolving only on new messages or timeout.
- `cli/src/channel-watch.mjs:18-28` — `channel watch` blocks indefinitely (`createResilientWatcher` with `persistent:true`, then `await new Promise(() => {})`).
- `cli/src/channel-recv.mjs:88-181` — `createResilientWatcher` is the core primitive: `fs.watch(PATHS.log)` for low-latency fast-path (lines 122-130) plus a 250ms inode/size stat-poll safety net (lines 139-171) that also detects host restart and resets the cursor.
- `cli/src/channel-core.mjs:81-99` — server-side `LogStore.wait()` long-poll: `/recv` reserves a waiter per name that resolves when a new message arrives (`log-store.mjs:42-62`) or `maxMs` fires (`log-store.mjs:128`).
- `cli/src/channel-host.mjs:61-106` — the bridge that wires relay → local log (registers `/send /recv /peers`, watches `outbox/`, persists to `log.jsonl`).

The tool-relay model should get the same shape: either reuse `createResilientWatcher` for a co-located agent (Finding 3) or generalize `LogStore.wait()` into the SDK tool path (Finding 1).

## Workaround in the wild

BlitzOS reinvented the missing primitive per-app as a shell script — a `wait.sh` that loops the 25s long-poll in bash and returns only on a real event (keeping `wait` under the 30s relay cap from Finding 2). It also runs a relay-url-file self-heal + agent re-exec to survive the stale-URL churn from Finding 5. Every app that wants event-driven agents currently has to build its own version of this. A first-class blocking-recv + sticky reconnection would obviate the per-app reinvention.

---

## Prioritized checklist

- [ ] **P0 — Blocking-recv primitive (Finding 1).** Generalize the channel `LogStore.wait()` waiter into the SDK tool model and/or ship a canonical "wait for event" helper so apps stop hand-rolling poll loops. TBD: confirm final API surface.
- [ ] **P0 — Sticky reconnection (Finding 5).** Preserve session-id + tokens + URL across transient WS drops so the agent's baked URL doesn't go stale. Coordinate with `sdk-reconnect-remint-race.md`.
- [ ] **P1 — Longer/configurable hold cap (Finding 2).** Document `MAX_SYNC_TOOL_MS` (`relay-do.ts:556`, default 30000) and expose a longer, per-request-configurable hold so one long-poll can block minutes. Confirm the edge ceiling on held HTTPS requests.
- [ ] **P1 — True push to the agent (Finding 3).** Add an agent-side SSE/WS subscription, or expose the channel local-log path for co-located agents.
- [ ] **P2 — Neutral framing guidance (Finding 4).** Keep the SDK default neutral (already is) and document that aggressive "stay reachable / poll forever" framing is unnecessary and risks cyber-classifier flags. Audit shipped templates for reachability framing to soften.

## Provenance

Surfaced 2026-06-12 during a BlitzOS-driven session on tool-relay agent ergonomics. Grounded against the relay/SDK/CLI source as cited above. Findings 4 and 5 each have a parallel note in the BlitzOS repo (framing softening; stale-URL self-heal).
