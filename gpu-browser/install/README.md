# gpu-browser/install

What `npx @agent-socket/gpu-browser` runs as root, once per install or update, after asking you: one sudo password prompt for all of it.

| File | |
|---|---|
| `install.sh` | Creates the account, downloads, self-tests, installs. POSIX `sh` (macOS's bash 3.2 and Debian's dash). |
| `uninstall.sh` | Removes all of it. A root-owned copy is kept at `/opt/agent-socket-gpu-browser/uninstall.sh`, so removal works even if this package is gone. |
| `node.txt` | The Node.js version the server runs on, with the SHA-256 of each tarball; a download that doesn't match is refused. |
| `system-README.md` | Becomes `/opt/agent-socket-gpu-browser/README.md`. |
| `home-README.md` | Becomes the README in the account's home, `/opt/agent-socket-gpu-browser/home/`. |
| `user-README.md`, `agent-socket-README.md` | Become `~/.agent-socket/gpu-browser/README.md` and `~/.agent-socket/README.md` (the CLI writes these, as you). |

## What install.sh does, in order

1. **The account `agent-socket-gpu-browser`**, unless it exists already, in which case it must carry this installer's marker or nothing is touched.
   - **macOS:** its own group, then the user with `dscl`, the way MacPorts creates its `macports` user: no password (`*`), shell `/usr/bin/false`, and the attributes macOS adds on its own (`AuthenticationAuthority` and friends) deleted. It can't log in and doesn't appear in Users & Groups or the login window. First free uid from 501.
   - **Linux:** `groupadd --system`, `useradd --system`, shell `nologin`. It is also added to the `render`/`video` groups if they exist, so Chromium can open the GPU.
2. **`/opt/agent-socket-gpu-browser/`**, owned by root, and its `home/` (the account's, mode 700).
3. **Downloads, run as the account** (no third-party code runs as root):
   - Node.js, checked against `node.txt`;
   - `playwright-core`, with `npm install --ignore-scripts`;
   - Chromium.
4. **A fresh root-owned copy** of all that: the account can run it but not change it.
5. **A self-test of the new copy, started exactly the way every run starts it** (macOS: `launchctl asuser <uid> sudo -u …`). It launches Chromium with its sandbox, draws a WebGL canvas and reports the GPU. On Ubuntu 23.10+, where Chromium's sandbox needs an AppArmor profile, it adds one for this Chromium only. If the test fails, nothing is swapped in: an existing install keeps working.
6. **Swap** the new copy in, and write `install.env` (who installed it, version, the GPU).
7. **The sudo rule** `/etc/sudoers.d/zz-agent-socket-gpu-browser`, validated with `visudo` first. It is named `zz-…` so it is read last: sudo applies the last rule that matches, and a broader rule of yours for the same command would otherwise ask for the password. It lets the installing user run exactly the start command (that one command, those arguments) without a password:
   - **macOS:** `launchctl asuser <uid> /usr/bin/sudo -u agent-socket-gpu-browser -H …/node …/server.mjs`;
   - **Linux:** `…/node …/server.mjs` as the account.

   If `/etc/sudoers` doesn't read `/etc/sudoers.d`, there's no rule and each start asks for the password.
8. **Checks whether the account can open your home folder.** If it can, the CLI offers to close it (`chmod 700`) and remembers the old mode for uninstall.
