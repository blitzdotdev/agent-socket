# sdk: malformed `tool_call` frame throws before the try block → unhandled rejection, no tool_reply, agent hangs

## What's wrong

`_handleToolCall` (`sdk/src/session.ts:253`) computes the route on its very first line, **before** the `try` that is supposed to guarantee a `tool_reply`:

```ts
async _handleToolCall(msg: any): Promise<void> {
  const route = `${(msg.method as string).toUpperCase()} ${msg.path as string}`
  ...
```

`msg.body` and `msg.headers` are defensively defaulted later (`?? ""`, `?? {}`), but `msg.method` and `msg.path` are not. If a `tool_call` frame arrives with `method` missing or non-string — `{ type: "tool_call", id: "x", path: "/foo" }` — then `msg.method` is `undefined` and `.toUpperCase()` throws a `TypeError`.

The call site is fire-and-forget: `case "tool_call": void this._handleToolCall(msg)` (`:206`). So the throw becomes an **unhandled promise rejection**, and — because it happens outside the `try` — the handler's catch that would send a `500` `tool_reply` never runs.

## Why it matters

- **No `tool_reply` is ever sent**, so the agent's HTTP request to the relay hangs until `MAX_SYNC_TOOL_MS` (30 s) before the relay returns `tool_timeout`. Every malformed-frame tool call costs the agent a 30-second stall.
- The unhandled rejection can crash a Node process under `--unhandled-rejections=strict`, or surface as a noisy error in a Worker / browser.
- A buggy relay, a protocol-version skew, or a malicious peer can trigger this with one crafted frame.

(`msg.path` missing is less severe: the route becomes `"GET undefined"`, misses, and returns a 404 reply — wrong, but at least it replies.)

## What to do

- Validate `msg.method` / `msg.path` before building the route (coerce/guard, or reply `400` for a malformed frame), and do it **inside** a try that always emits a `tool_reply` for any frame carrying an `id`.
- Move the route computation inside the existing `try`, or add a top-of-function guard that sends an error `tool_reply` and returns.

## Acceptance

- A `tool_call` frame with missing/non-string `method` produces a `tool_reply` (error status) for that `id`, no unhandled rejection, and no 30 s agent hang.
- Normal tool calls are unaffected.

## Provenance

Found during a full line-by-line audit. Verified `_handleToolCall`'s route line (`session.ts:253`) is the first statement, outside the `try` at `:266`, and the dispatch is `void this._handleToolCall(msg)` at `:206`.

## Resolution (2026-10-05)

Already fixed before wt/sdk-ext: _handleToolCall validates method/path and replies 400 bad_tool_call.
