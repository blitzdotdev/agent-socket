# GPU browser

A Chromium on your own machine, with your machine's GPU, that an agent anywhere (a cloud Claude session, any chat that can make HTTPS calls) uses through an agent-socket link: it uploads a page and its assets, opens it, runs JavaScript in it and gets screenshots back. Made for WebGL/WebGPU work (three.js and the like), which cloud sandboxes render in software or not at all.

It is a separate app from the [Chrome extension](../chrome-extension/README.md): the extension lets an agent use a tab of *your* browser; the GPU browser is a different, headless Chromium that never sees your tabs, logins or files, and keeps rendering while you use your computer.

## Use it

```bash
npx @agent-socket/gpu-browser
```

The first run explains what it will install and asks once (one sudo password prompt). Then it prints a link and copies it to the clipboard: paste it into the agent's chat. The link works for 60 minutes (`--for 2h`, `--for none`); Ctrl-C ends it at once.

| | |
|---|---|
| `npx @agent-socket/gpu-browser` | Start (installs or updates first if needed) |
| `npx @agent-socket/gpu-browser status` | What is installed, where, the GPU it found, whether the sudo rule works, whether it runs |
| `npx @agent-socket/gpu-browser stop` | Stop one running in another terminal |
| `npx @agent-socket/gpu-browser uninstall` | Remove the account, the sudo rule and `/opt/agent-socket-gpu-browser` |

When the agent wants a page to reach another host (a CDN, an API), the terminal rings and asks: `y` allows it for this session, `always` also remembers it, anything else refuses. Only that terminal can answer.

macOS and Linux. Needs Node.js 18+ for `npx`; the browser brings its own Node.js 22. On a machine without a usable GPU (a VM, CI) it still works, rendering in software, and says so.

### What gets installed

One sudo prompt covers all of it (details and order: [install/README.md](install/README.md)):

- **An account, `agent-socket-gpu-browser`**, that runs the browser. It can't log in, has no password, has its own group, and can't read your files. On macOS it doesn't appear in Users & Groups or at the login window.
- **`/opt/agent-socket-gpu-browser/`**: Node.js (pinned by checksum), `playwright-core`, Chromium (~400 MB together). Owned by root, so the account can run it but not change it.
- **One sudo rule**, `/etc/sudoers.d/zz-agent-socket-gpu-browser`. It lets you start that exact server as that account without a password. Nothing else.
- **On Ubuntu 23.10+**, an AppArmor profile that lets this Chromium use its sandbox.
- **If other accounts can open your home folder**, it offers to close it (`chmod 700`), and uninstall offers to reopen it.

Before switching to a new version, it starts Chromium from the new copy the way every run does and checks it renders. Updates replace the copy only if that works.

Your settings are in `~/.agent-socket/gpu-browser/`: `allowed-hosts.txt` (hosts you allowed with `always`; edit freely) and an optional `config.json`. See the README there.

### Where things are

| Part | Folder |
|---|---|
| The server: browser, network boundary, the agent's tools, the link | [`app/`](app/README.md) |
| The CLI (`npx`), runs as you | [`bin/`](bin/README.md) |
| What runs as root, once per install | [`install/`](install/README.md) |
| Tests | [`test/`](test/README.md) |

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

- **The account.** The server and Chromium run as `agent-socket-gpu-browser`, which can't log in and can't read your files (the installer checks your home folder from that account's side). World-readable files elsewhere on the machine are readable by it, as by any local account.

The agent can use the machine's GPU, CPU and memory until the link ends.

## Development run

Without installing (no separate account), from the repo root:

```bash
npm install && npm run build
# the config line, then your terminal as the rest of stdin: type `answer <id> allow`, or Ctrl-D to stop
( echo '{"relay":"https://agentsocket.dev","key":"'"$(openssl rand -hex 16)"'","minutes":60}'; cat ) \
  | node gpu-browser/app/server.mjs     # the link arrives as a `link` event
```

The first line on stdin is the config; see the header of [`app/server.mjs`](app/server.mjs) for the whole control protocol. A development run may set `"chromium": {"executablePath": "...", "sandbox": false}` (CI, root); an install can't.

## Tests

- `npm run gpu:test:unit`: the boundary checks ([`test/`](test/README.md)).
- `node harness/run.mjs 63` with `CHROMIUM_PATH` set: the server end to end against a local relay (uploads, pages, multi-part screenshots, the private-network refusal with a local server that must get 0 hits, the proxy's password, an approval round trip, forged events, `stop`).
- `sh gpu-browser/test/install-smoke.sh`: a real install, start, use and uninstall. CI runs it on fresh Ubuntu and macOS runners (`.github/workflows/gpu-browser.yml`); don't run it on a machine where you use the GPU browser, since it ends by uninstalling.
