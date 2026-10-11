# /opt/agent-socket-gpu-browser

Installed by `npx @agent-socket/gpu-browser` ([source](https://github.com/blitzdotdev/agent-socket/tree/master/gpu-browser)): a headless Chromium that an AI agent you give a link to can use to render on this machine's GPU. It runs as the account `agent-socket-gpu-browser`, which can't log in and can't read your files.

| | |
|---|---|
| `node/` | Node.js, pinned by version and checksum |
| `app/` | The server (`server.mjs`) and `playwright-core` |
| `browsers/` | Chromium |
| `home/` | The account's home: Chromium's temporary profile while it runs |
| `install.env` | Who installed it, the version, the GPU the self-test found |
| `uninstall.sh` | Removes everything listed here |

Everything except `home/` belongs to root: the account can run it, not change it. There is also a sudo rule, `/etc/sudoers.d/zz-agent-socket-gpu-browser`, that lets the user who installed it start the server as the account without a password (that one command only), and on Ubuntu possibly an AppArmor profile, `/etc/apparmor.d/agent-socket-gpu-browser`, for Chromium's sandbox.

- Start: `npx @agent-socket/gpu-browser`
- See what's installed: `npx @agent-socket/gpu-browser status`
- Remove all of it: `npx @agent-socket/gpu-browser uninstall`, or `sudo sh /opt/agent-socket-gpu-browser/uninstall.sh`
