# relay: app-controlled content-type serves HTML/JS on agentsocket.dev origin (stored XSS), no nosniff/CSP

## What's wrong

`buildToolResponse` (`relay/src/relay-do.ts:625`) returns the app's body verbatim with an app-declared `content-type` whenever the body is a string:

```ts
function buildToolResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  const contentType = extractContentType(headers)
  if (contentType && typeof body === "string") {
    return new Response(body, { status, headers: { "content-type": contentType } })
  }
  ...
}
```

There is **no `X-Content-Type-Options: nosniff`, no `Content-Security-Policy`, and no `X-Frame-Options`** anywhere in the relay (verified: grep returns nothing across `relay/src/`).

This bites hardest on the **`/_as_tasks/<id>` poll path**. That path:
- is matched at `relay-do.ts:494`, which is **before** the `Sec-Fetch-Site` CSRF gate at `:532` — i.e. it is one of the deliberately CSRF-exempt meta paths, reachable by a plain browser `GET`;
- calls `buildToolResponse(task.status, task.body, { "content-type": task.contentType })` at `:506`, where `task.contentType` and `task.body` were both supplied by the connected app via `task_complete` (stored at `:409`).

So an app can park a completed task whose `content-type` is `text/html` and whose body is an HTML document, and the relay serves it as executable HTML from `https://agentsocket.dev/v1/t/<token>/_as_tasks/<id>` to any browser that opens that URL.

The production app registry (`relay/apps.json`) ships `as_app_anon` and `as_app_pixel_art` with `allowedOrigins: ["*"]`, so "the app" is effectively "anyone who can open a WebSocket and register."

## Why it matters

- Active script execution in the relay's first-party origin (`agentsocket.dev`). No cookies exist today so session theft is moot, but it enables convincing phishing under the trusted brand domain, clickjacking of `/privacy` or any future first-party surface, and origin-confusion against anything the domain later serves.
- The token URL is already "paste-this-into-an-AI-chat" shareable, so a hostile app can hand a victim a stable `agentsocket.dev/.../_as_tasks/<id>` link that looks like a legitimate result page and executes attacker JS.
- `agents.md` (`text/markdown`) and `tools.json` (`application/json`) are also served from these CSRF-exempt paths with no `nosniff`, so a MIME-sniffing browser can still treat app-controlled `agents.md`/`appDescription` content as HTML.

## What to do

1. Always set `X-Content-Type-Options: nosniff` on **every** relay response (cheap, covers the sniffing angle for `agents.md`/`tools.json` too).
2. For browser-reachable surfaces, restrict the passthrough content-type to a safe allowlist (e.g. `text/plain`, `application/json`, `text/csv`, `image/*`) and refuse to serve app-supplied `text/html`/`image/svg+xml`/`application/xhtml+xml` inline — or force `Content-Disposition: attachment` / a restrictive CSP on tool + task responses.
3. Consider a blanket `Content-Security-Policy: default-src 'none'` on tool/task/meta responses (they should never need to load scripts).

## Acceptance

- A `task_complete` with `content-type: text/html` and an HTML string body, polled via `GET /v1/t/<token>/_as_tasks/<id>` from a browser, does NOT execute as HTML (served as text/plain, or as an attachment, or rejected).
- All relay responses carry `X-Content-Type-Options: nosniff`.
- The content-type passthrough feature (the legitimate `text/x-shellscript` / CSV / text use cases from `relay-tool-content-type`) still works for non-HTML types.

## Provenance

Found during a full line-by-line audit of the package. Verified: `buildToolResponse` content-type passthrough (`relay-do.ts:625-633`), `/_as_tasks/` GET handler precedes the CSRF gate (`:494` vs `:532`), and no `nosniff`/CSP/`X-Frame-Options` header is emitted anywhere in `relay/src/`. The CSRF Sec-Fetch-Site gate itself is not bypassed — this is a separate content-type/header-hardening gap on the intentionally-exempt meta surface.
