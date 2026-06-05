# Relay: tool handlers should be able to return non-JSON content types

## What's blocked today

Tool handlers can only effectively return JSON. The relay's `handleToolReply` in `relay/src/relay-do.ts` constructs the agent-facing HTTP response with a hardcoded `content-type: application/json; charset=utf-8` and JSON-serializes `msg.body`. Even if a handler returns `{ status: 200, body: "<html>...", headers: { "content-type": "text/html" } }`, the relay ignores the headers and stringifies the body.

This forces awkward client-side unpacking when a tool wants to serve anything else. Concrete example: the channel host's `GET /join.sh` returns a bash script. To deliver it as text, the script is wrapped in `{ "script": "..." }` and the friend's one-liner has to pipe through `jq -r .script` to extract.

## What to do

Honor `headers` and the response body shape in the tool_reply frame:

- If the handler returns `{ status, headers, body }`:
  - If `headers["content-type"]` is present and the body is a string → send the string as-is with that content type.
  - If body is bytes (`ArrayBuffer` / `Uint8Array`) → pass through with the declared content type.
  - Else → existing behavior (`JSON.stringify`).
- The relay should still enforce its own response headers (CORS, cache-control) on top of whatever the handler sets — but `Content-Type` should be settable by the handler.

Implementation touches:
- `relay/src/types.ts` — `ToolReplyFrame` already has `body: unknown`; might need `headers?: Record<string, string>`.
- `relay/src/relay-do.ts` — `handleToolReply` branches on body type + declared headers.
- `sdk/src/session.ts` — pass through headers from `ToolResult`. The SDK type `ToolResult` already declares `{ status?, body?, headers? }`-ish but let me verify.

## Why this matters beyond join.sh

- HTML responses (rendered pages served by the app, e.g. a tool inspector)
- Image responses (e.g. a screenshot tool returning a PNG)
- CSV / TSV exports (e.g. "give me my data")
- Markdown rendered to a chat-friendly view
- Anything where the AI's HTTP client expects a specific content type to render or parse correctly

## Acceptance

- A test scenario registers `{ method: "GET", path: "/page.html", handler: () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<h1>hi</h1>" }) }`.
- Curling `/v1/t/<token>/page.html` returns `<h1>hi</h1>` with `Content-Type: text/html`, NOT JSON-stringified.
- Existing JSON-returning tools continue to work unchanged.
- `agents.md` and `tools.json` are unaffected (they're served by the relay directly, not via tool calls).

## Provenance

Encountered 2026-05-21 while building `channel host`'s `/join.sh` endpoint. Workaround: serve the script wrapped in JSON, require the friend's one-liner to include `| jq -r .script`. Works fine but inelegant — and breaks any "paste this URL into the address bar" UX.

---

**CLOSED 2026-06-05.** Implementation:

- `relay/src/types.ts` — `ToolReplyFrame` and `TaskCompleteFrame` gain optional `headers?: Record<string, string>`.
- `sdk/src/types.ts` — `ToolResult` object branch formalizes `headers?: Record<string, string>`. `Session.completeTask`'s `result` arg gains the same field.
- `sdk/src/session.ts` — `_handleToolCall` and `completeTask` forward `headers` on the wire when the handler set them; `normalizeResult` extracts them.
- `relay/src/relay-do.ts` — new `buildToolResponse(status, body, headers?)` helper used by both the sync (`handleToolReply`) and async (`/_as_tasks/<id>` poll) paths. `PendingTask` gains `contentType?` carrying the handler's declared type through the completion flow. Case-insensitive `content-type` lookup via `extractContentType`.

**Contract (v0):**
- handler returns `{ status, body: <string>, headers: { "content-type": X } }` → relay serves the string verbatim with `Content-Type: X`.
- handler returns the legacy `{ status, body }` (no headers) → JSON-stringify, `Content-Type: application/json; charset=utf-8` (unchanged).
- handler returns content-type with a non-string body → relay falls back to JSON. Bytes (ArrayBuffer/Uint8Array) are not yet supported — the wire frame is JSON-encoded and binary doesn't round-trip. Future: explicit `bodyEncoding: "base64"` or a separate binary WS frame type.

**Channel host updated:** `/join.sh` now serves the bash script with `Content-Type: text/x-shellscript` directly. The share one-liner simplifies from `bash <(curl -s URL/join.sh | jq -r .script) "" "name"` to `bash <(curl -s URL/join.sh) "" "name"` — no more `jq` dependency.

**Harness:** new scenario `40-tool-content-type` covers text/html, text/plain (case-insensitive Content-Type header), legacy JSON path, declared-content-type-with-object-body fallback, custom-status + content-type, and verifies `/agents.md` and `/tools.json` are unaffected. 45/45 scenarios pass.
