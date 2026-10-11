# ~/.agent-socket/gpu-browser

Your settings for the agent-socket GPU browser (`npx @agent-socket/gpu-browser`), which lets an AI agent you give a link to render on this machine's GPU. All of it is optional and plain text.

| File | |
|---|---|
| `allowed-hosts.txt` | Hosts the browser's pages may reach, one per line (`*.example.com` covers its subdomains). When an agent asks for a host and you answer `always`, it is added here. Delete a line to take it back. Empty means: only the agent's own uploads. |
| `config.json` | Optional: `{"minutes": 120}` (how long a link lives; `0` = until you stop it), `{"relay": "https://..."}` (another agent-socket relay), `{"chromiumArgs": ["--use-angle=vulkan"]}` (GPU flags only; others are ignored). |
| `home-mode-before.txt` | Only if the installer closed your home folder: its mode before, so uninstall can put it back. |

The browser itself is installed in `/opt/agent-socket-gpu-browser` (see its README). Remove it with `npx @agent-socket/gpu-browser uninstall`; that leaves this folder, which you can delete by hand.
