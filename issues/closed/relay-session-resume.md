# Session identity does not survive a reconnect, so the pasted URL dies

## What was wrong

Every `/v1/_ws` upgrade minted a fresh session-id, so a reconnecting app landed
in a different Durable Object and every agent URL it had handed out died on any
network blip or MV3 service-worker restart. The SDK re-minted and reported the
new URLs through `onSessionChanged`, but the URL already pasted into a chat
stopped working.

## Fix

- `register_reply` carries a `resumeSecret` (32 random bytes, memory only).
- On a drop other than a clean `1000` close the DO holds the registration,
  tokens and async tasks for `RESUME_GRACE_MS` (default 60 s). Agents get
  `agents.md` / `tools.json`; tool calls get `503 app_offline` +
  `Retry-After: 2`. In-flight calls still fail at the drop.
- The app reattaches on `/v1/_ws?session=<id>` and sends a `resume` frame (the
  secret travels in the frame, not the URL) with its current registration and
  any tokens it revoked offline. Constant-time compare; refusal is
  `resume_failed` + close `4401`. A valid resume replaces a still-attached
  socket (`4410`); a plain upgrade on a held session still gets `4409`.
- SDK resumes first and only re-mints when the resume is refused; the Chrome
  extension resumes across service-worker restarts from
  `chrome.storage.session`.

Tests: harness 41, 52–55; `sdk/test`; `chrome-extension/test/reconnect.*`.
Follow-up: `issues/open/relay-hibernation.md`.
