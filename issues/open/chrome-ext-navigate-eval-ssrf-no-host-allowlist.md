# chrome-ext: `/navigate` (and `/eval` fetch) have no scheme/host restriction — SSRF, local-file read, private-network access

## What's wrong

`/navigate` (`chrome-extension/lib/tools-base.js:472-490`) passes the AI-supplied URL straight to `chrome.tabs.update` with only a `typeof` check:

```js
if (typeof args.url !== "string") return bad("expected { url: string }")
...
await chrome.tabs.update(tabId, { url: args.url })
```

No scheme allowlist, no host validation. Combined with the read-back tools (`/get_text`, `/get_html`, `/page_info`), and with `/eval` running arbitrary JS (including `fetch()`) in the page's MAIN world, a remote AI can reach resources it otherwise can't:

- `/navigate { url: "file:///etc/passwd" }` then `/get_text` → local file exfiltration.
- `/navigate { url: "http://169.254.169.254/latest/meta-data/..." }` → cloud instance metadata.
- `/navigate { url: "http://localhost:6379/" }` / `http://192.168.x.x/...` → internal/private-network services.
- `/eval { code: "return await (await fetch('http://localhost:9200/_cat/indices')).text()" }` → in-page `fetch` with the browser's network position and the page origin.

The extension holds `<all_urls>` host permissions, so there is no network boundary confining where the remote AI can point the browser.

## Why it matters

The driver of these tools is a **remote** party (the AI, reached through the public relay). With no scheme/host restriction, that remote party can use the user's browser as an SSRF proxy into the user's local machine, LAN, and cloud metadata endpoints, and can read local files via `file://`. This is the systemic "no host allowlist confining the remote AI" gap; `/navigate` is the most direct instance, and `/eval`'s in-page `fetch` is the general one.

(Distinct from the already-filed `chrome-ext-keybind-url-scheme`, which only covers `/configure_keybind`'s URL scheme. `/navigate` has the same hole and is not on that issue.)

## What to do

- Restrict `/navigate` to `http:`/`https:` and reject `file:`, `chrome:`, `chrome-extension:`, `data:`, `blob:`, `about:`.
- Block private/loopback/link-local/metadata hosts (`localhost`, `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `*.local`, `169.254.169.254`, `metadata.google.internal`) by default, with an explicit opt-in if a user really wants local-app driving.
- Introduce a **host allowlist** (or per-call confirmation) that confines which origins the AI may navigate to / fetch from, as the systemic mitigation. `/eval`'s in-page fetch can't be fully constrained, but the navigate/host-scope guard plus a documented threat model substantially narrows the blast radius.

## Acceptance

- `/navigate` to `file://`, `localhost`, private ranges, and `169.254.169.254` is rejected by default.
- Normal `https://` navigation within the bound tab still works.

## Provenance

Found during a full line-by-line audit. Verified `/navigate` (`tools-base.js:485-490`) validates only `typeof args.url === "string"` before `chrome.tabs.update`, and that `/eval` injects arbitrary MAIN-world code (`:177-184`) which can call `fetch`. Manifest grants `<all_urls>`.
