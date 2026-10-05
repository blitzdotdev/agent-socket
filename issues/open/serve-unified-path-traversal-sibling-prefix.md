# scripts/harness: static file servers have a sibling-prefix path-traversal bypass (`startsWith(PKG_ROOT)` with no separator)

## What's wrong

Both static file servers guard the resolved path with `startsWith(PKG_ROOT)` but **without a trailing path separator**:

`scripts/serve-unified.mjs:49-56`:
```js
const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname)
...
let filePath = path.join(PKG_ROOT, urlPath.replace(/^\/+/, ""))
if (!filePath.startsWith(PKG_ROOT)) {        // no path.sep boundary
  res.writeHead(403); res.end("forbidden"); return
}
```

`harness/lib/browser.mjs:51-54` has the identical pattern.

`new URL(...).pathname` does **not** decode `%2f`, so an encoded `..%2f` survives URL normalization; `decodeURIComponent` then turns it into `../`. A request like:

```
GET /..%2fagent-socket-secrets%2ffile
```

decodes to `../agent-socket-secrets/file`, joins to `…/packages/agent-socket-secrets/file`, and **passes** `startsWith("…/packages/agent-socket")` because the sibling directory shares the `agent-socket` prefix.

## Why it matters

`scripts/serve-unified.mjs` binds `0.0.0.0` and is explicitly intended to be fronted by a **public Cloudflare tunnel** ("a single Cloudflare tunnel URL gives end-users access"). So any sibling directory/file under `packages/` whose name begins with `agent-socket` (backups, exports, a `agent-socket-secrets`, etc.) is internet-reachable through this traversal. The boundary bug is unambiguous; exploitability depends on a readable `agent-socket*`-prefixed sibling existing at the time.

`harness/lib/browser.mjs` is test-only/localhost, so lower impact, but it has the same defect and should be fixed for consistency.

## What to do

- Compare against `PKG_ROOT + path.sep` (and handle the exact-root request separately), or resolve with `path.resolve` and verify `resolved === PKG_ROOT || resolved.startsWith(PKG_ROOT + path.sep)`.
- Reject paths containing `..` after decoding, as defense in depth.

## Acceptance

- `GET /..%2fagent-socket-anything%2fx` returns 403, not the sibling file.
- Legitimate requests under the package root still serve.

## Provenance

Found during a full line-by-line audit. Verified the boundary check in `serve-unified.mjs:56` and `browser.mjs:53` uses `startsWith(PKG_ROOT)` with no separator, and that `decodeURIComponent(new URL().pathname)` lets `%2f`-encoded `..` survive into `path.join`. `serve-unified.mjs` binds `0.0.0.0` and is documented as tunnel-fronted.
