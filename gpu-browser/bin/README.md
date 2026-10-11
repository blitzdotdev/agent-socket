# gpu-browser/bin

`agent-socket-gpu-browser.mjs` is what `npx @agent-socket/gpu-browser` runs, as you: it installs or updates the browser (asking first, one sudo prompt, via `../install/install.sh`), starts the server as the `agent-socket-gpu-browser` account, prints the link, and asks you in this terminal when the agent wants more hosts. Also `status`, `stop`, `uninstall`, `help`. No dependencies.
