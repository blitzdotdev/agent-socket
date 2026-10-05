# relay: one oversized tool reply ends the whole session

## What's wrong

A frame from the app over `MAX_FRAME_BYTES` (4,194,304 characters) closes the
socket with `1009` and ends the session (`relay/src/relay-do.ts`, `onMessage`):
every link dies and the user has to paste a new one. The frame that trips it
is usually a `tool_reply` whose body is too big, e.g. `/screenshot` of a large
page as a base64 PNG data URL (base64 adds a third, so ~3 MiB of image). The
agent sees its call fail with `503 app_offline` and then every later call on
that link fails the same way.

## Why it ends the session

The relay refuses to parse a frame that big (parsing risks OOM for every
session in the isolate), so it can't tell which call it answers. Treating it as
a protocol violation was the simple, safe choice.

## Options

1. Detach instead of ending (hold the session, let the SDK resume): links
   survive, the one call fails with 503, but a buggy app could loop.
2. Find the `id` without a full parse (the SDK always serializes
   `{"type":"tool_reply","id":"…"` first) and answer that call with
   `502 reply_too_large`, keeping the socket.
3. SDK-side guard: measure the serialized `tool_reply` before sending and
   replace it with a `413`-style error reply. Cheapest, fixes SDK apps only.
4. Extension: cap `/screenshot` output (JPEG fallback, scale down).

3 + 4 look like the right first step; 2 makes the relay robust for non-SDK apps.
Documented today in docs/protocol.md → Limits ("Tool replies").
