# GPU browser

A Chromium on your own machine, with your machine's GPU, that an agent anywhere (a cloud Claude session, any chat that can make HTTPS calls) uses through an agent-socket link: it uploads a page and its assets, opens it, runs JavaScript in it and gets screenshots back. Made for WebGL/WebGPU work (three.js and the like), which cloud sandboxes render in software or not at all.

It is a separate app from the [Chrome extension](../chrome-extension/README.md): the extension lets an agent use a tab of *your* browser; the GPU browser is a different, headless Chromium that never sees your tabs, logins or files, and keeps rendering while you use your computer.

## Status

| Part | Where | State |
|---|---|---|
| Server: the browser, its network boundary, the agent's tools, the link | [`app/`](app/README.md) | this folder |
| Installer + CLI: `npx @agent-socket/gpu-browser`, creates the separate OS account it runs as, approvals in your terminal | `install/`, `bin/` | next PR |

Until the CLI lands, the server only runs as a development run (below).

## What the agent can do

The link's `agents.md` explains it to the agent; in short:

| Tool | |
|---|---|
| `GET /info` | GPU (WebGL renderer, WebGPU), versions, allowed hosts, open pages, limits, when the session ends |
| `POST /files`, `GET /files`, `POST /files/delete` | Upload files; pages load them from `https://uploads.gpu-browser.internal/<path>` (served from memory, never the network). Big files go in base64 pieces (`append`). |
| `POST /page` | Open an uploaded page (or an https page on an allowed host) in a fresh context, any viewport and scale |
| `POST /eval` | Run JavaScript in a page; returns its value and the console output |
| `POST /screenshot`, `POST /image` | PNG/JPEG, viewport, element, clip or full page; images too big for one reply (the relay's 4 MiB frame) come in parts |
| `POST /close` | Close pages (idle ones close after 15 minutes) |
| `POST /request` | Ask the owner to allow more hosts (a CDN, an API); returns a task the agent polls until the owner answers |
| `POST /define`, `POST /undefine` | Turn a page script into a tool on the same link, for this session |

## The boundary

Fixed in code ([`app/policy.mjs`](app/policy.mjs), applied by [`app/server.mjs`](app/server.mjs)); everything inside it needs no approval:

- **Network.** Every request Chromium makes goes through a proxy inside the server, protected by a password that changes every run (so no other program on the machine can use it). It allows only hosts on the allowlist (empty by default), ports 80 and 443, names (no IP addresses), and only when every address the name resolves to is public. Loopback, private ranges, link-local (cloud metadata), CGNAT, multicast and the IPv6 forms that embed an IPv4 address are refused, checked on the address it then connects to, so DNS rebinding doesn't get around it. Chromium resolves nothing itself, and QUIC and WebRTC UDP are off. Blocked requests are reported to the agent so it can upload the file instead or ask.
- **Code.** The agent's code runs only inside pages, with Chromium's sandbox on. Pages open only http(s) URLs.
- **Widening needs the owner.** `/request` sends an `ask` to whoever runs the server; the answer comes back on its stdin. Owner-supplied Chromium flags are limited to GPU settings; anything else (`--no-sandbox`, proxy or debugging flags) is dropped.
- **The link** is a bearer credential, as everywhere in agent-socket, and dies when the server stops or its timer runs out.

In an install (next PR) the server also runs as its own OS account, `agent-socket-gpu-browser`, which can't read your files.

## Development run

```bash
npm install && npm run build            # from the repo root
# the config line, then your terminal as the rest of stdin: type `answer <id> allow`, or Ctrl-D to stop
( echo '{"relay":"https://agentsocket.dev","key":"'"$(openssl rand -hex 16)"'","minutes":60}'; cat ) \
  | node gpu-browser/app/server.mjs     # the link arrives as a `link` event
```

The first line on stdin is the config; see the header of [`app/server.mjs`](app/server.mjs) for the whole control protocol. A development run may set `"chromium": {"executablePath": "...", "sandbox": false}` (CI, root); an install can't.

## Tests

- `npm run gpu:test:unit`: the boundary checks ([`test/`](test/README.md)).
- `node harness/run.mjs 63` with `CHROMIUM_PATH` set: the server end to end against a local relay (uploads, pages, multi-part screenshots, the private-network refusal with a local server that must get 0 hits, the proxy's password, an approval round trip, forged events, `stop`).
