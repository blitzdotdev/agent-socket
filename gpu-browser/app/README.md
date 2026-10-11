# gpu-browser/app

What runs as the `agent-socket-gpu-browser` account in an install (and as you in a development run). Copied as a whole into the install; nothing here is published on its own.

| File | |
|---|---|
| `server.mjs` | The server: the proxy, Chromium (via `playwright-core`), the agent's tools, the agent-socket session. Its header describes the stdin/stdout protocol with the CLI. `--self-test` launches Chromium, draws a WebGL canvas and prints the GPU it got (for the installer). |
| `policy.mjs` | The boundary checks (hosts, addresses, upload paths, tool paths, Chromium flags, text shown to the owner). No I/O; unit tested in `../test/`. |
| `lib/sdk/` | This repo's `@agent-socket/sdk`, vendored by `../scripts/vendor-sdk.sh` (CI checks it is fresh). |
| `package.json` | Its one dependency, `playwright-core`, pinned exactly. |

See [../README.md](../README.md) for what it does and its security boundary.
