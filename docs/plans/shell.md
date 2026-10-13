# agent-socket shell: plan

Status, 2026-10-13: the CLI is built (`shell/`, tested by `harness/scenarios/64-shell.mjs`). It hasn't been run on a Mac yet. The macOS menu bar app (below) isn't started.

## The use case

My Mac's disk is almost full. I want a cloud agent (a Claude Code cloud session, a chat with a code sandbox, anything that can make HTTPS calls) to find what's taking the space and clean it up. I don't want to install an agent on the Mac, and I don't want to copy each command from the chat into a terminal and each output back. I want to watch every command go by and say yes or no to it.

## What it is

```bash
npx @agent-socket/shell
```

One terminal. It prints a link and copies it to the clipboard. You paste the link into the agent's chat. Each command the agent sends shows up in that terminal; you press Enter to run it (or refuse, edit, or switch to auto). The output shows in the terminal and goes back to the agent as the call's result. Ctrl-C at the prompt ends the session, and the link dies at once.

Nothing is installed: no daemon, no account, no config file. The process lives as long as the terminal does.

## What it deliberately doesn't do

- **No command parsing, classification or rules.** The cloud agent's own harness already decides what to try. The person at the terminal decides what runs. Nothing in between.
- No AI reviewer, sandbox, installer, OS account, background service, or approvals from another device.
- **No relay changes.** It's an ordinary agent-socket app on the existing protocol and SDK.

## For the agent

`agents.md` says: this is a shell on the user's machine; a person reads every command before it runs and may refuse it or send a note back; send one command at a time, with a one-line `why`; keep output short (pipe through `head`, `tail` or `sort | tail`); nothing interactive except `sudo`, whose password the user types; each command runs in a fresh shell, so use absolute paths or `cwd`. It includes a small `run` shell function that posts a command and polls until the result arrives, so an agent in a sandbox can just write `run 'du -xh -d1 ~ | sort -h | tail -20'`.

| Tool | |
|---|---|
| `GET /info` | OS, user, home, shell, mode (`step`/`auto`), when the session ends. |
| `POST /run` | Body `{"cmd": "...", "why": "...", "cwd": optional, "timeout_s": optional (default 300)}`. |

`/run` holds the call up to 25 s (under the relay's 30 s limit). If the command was approved and finished by then, the result is the response. Otherwise the response is `202 {"taskId"}` and the agent polls `<link base>/_as_tasks/<taskId>`, as with any async agent-socket tool. The result is plain text (easier for a model to read than JSON-escaped output), the same either way:

```
status: done            (done | refused | timed_out | killed | error)
exit: 0
seconds: 3.1
ran: …                  (only if the user edited the command)
note: …                 (only if the user wrote one when refusing)
truncated: …            (only if output was cut)
---
<stdout and stderr, interleaved>
```

## In the terminal

```
Link (copied): https://agentsocket.dev/v1/t/as_…/agents.md
Paste it into your agent. Ends in 60 min · Ctrl-C ends it now · mode: step

── 1 · why: see what's using space in your home folder
$ du -xh -d1 ~ 2>/dev/null | sort -h | tail -15
[Enter] run   [n] refuse   [e] edit   [a] auto from now
  …output streams here…
✓ exit 0 · 3.1 s · sent

── 2 · why: remove the old Xcode build products (31 GB)
$ rm -rf ~/Library/Developer/Xcode/DerivedData
[Enter] run   [n] refuse   [e] edit   [a] auto from now
n
Tell the agent why (optional): keep DerivedData, I'm mid-build. Look at Docker instead.
✗ refused · sent
```

- **step** (default): every command waits for a key.
- **auto**: `a` switches it on. Commands run as they arrive and are still printed. `s` goes back to step.
- **refuse**: optionally type a note, which goes to the agent as `note`. That's how you steer it without the chat.
- **edit**: the command is put on an editable line (a multi-line one opens in `$EDITOR`). What you submit runs, with no second confirmation, and the result reports it as `ran:`.
- Several calls at once wait in a queue, one at a time, and the prompt shows how many are waiting.
- **Ctrl-C while a command runs** stops that command (result `killed`) and keeps the session. **Ctrl-C at the prompt** ends the session.
- The link lasts 60 minutes by default (`--for 2h`, `--for none`).
- The command and the `why` come from the agent, so control characters in them are shown escaped (as `clean()` does in `gpu-browser/app/policy.mjs`), so what you read is what runs. That's display hygiene, not parsing.

## How a command runs

- `$SHELL -c "<cmd>"` from the CLI's own environment, starting in the home folder unless `cwd` is given.
- stdin is the terminal, so `sudo` and y/n prompts reach you. stdout and stderr are piped: shown live and captured.
- **Not detached**, so the command stays in the terminal's foreground process group. Ctrl-C reaches it the way it does in a normal shell, and the CLI ignores that SIGINT while a command runs (a second Ctrl-C kills the command's process tree). `detached: true` would start a new session with no terminal, and then `sudo` couldn't ask for the password.
- As in a terminal, Ctrl-C doesn't reach the command's background jobs (`cmd &`): a non-interactive shell ignores SIGINT in them, and by the time the CLI hears the Ctrl-C the shell has exited and they belong to init. A timeout does stop them: it walks the process tree (`ps`) while the shell is still alive. A background job that keeps the output pipe open doesn't hold up the result: reading stops 1 s after the command exits.
- The CLI's key reading (raw mode) is paused while a command runs and restored after.
- Captured output is cut to fit the relay's 64 KiB async result (measured as JSON): the head and the tail are kept, with `truncated: true`.

## Package

- A new folder `shell/` in the agent-socket repo. One file, `bin/agent-socket-shell.mjs`, plus `package.json`.
- The SDK is vendored the way `gpu-browser` does it (`scripts/vendor-sdk.sh`) until `@agent-socket/sdk` 0.2.0 is on npm.
- Needs Node 22+, because the SDK uses the built-in `WebSocket`. That's the one thing the Mac must have. Without it, the CLI says so and stops.
- Clipboard: `pbcopy` on macOS, `wl-copy` or `xclip` if present, otherwise the link is just printed.

## Tests

Done: a harness scenario runs the CLI under a pseudo-terminal (`script`) against a local relay and plays the agent with `fetch`:

- run with Enter: the result comes back, both sync and via a 202 task
- refuse with a note
- edit
- auto mode, and back to step
- a queue of 3 calls
- Ctrl-C during `sh -c 'sleep 100 & sleep 100'`: `killed`, no leftover `sleep`, session still up
- timeout
- truncated output
- a command with an escape sequence is shown escaped
- Ctrl-C at the prompt: the link then answers `503 app_offline`

Still to do: the real check, an actual disk cleanup on a Mac from a cloud agent through this. Pausing Node's stdin so a command reads the terminal (sudo's password) was checked on Linux only.

## Security, in short

- While it runs, the link is a shell on your machine, gated only by you at the terminal. In step mode nothing runs without a key press; auto is your explicit choice and you can see everything.
- On agentsocket.dev the relay sees commands and output in plaintext after TLS. Self-host the relay if that matters.
- It ends on Ctrl-C, on the timer, or when the terminal closes.

## Next: a macOS menu bar app

The same thing as a menu bar icon on the Mac, the way the Chrome extension's button sits in Chrome's toolbar: click it for the link, see the waiting command, Run / Refuse (with a note) / Edit, an auto switch, and a notification when a command arrives. Native Swift, so it needs no Node, and it gives the agent the same `/info` and `/run` contract (the same `agents.md`).

Found so far: Swift's Foundation on Linux can't open WebSockets ("WebSockets not supported by libcurl"), so the app's relay client can only be built and tested on a Mac, not in this repo's Linux CI. To decide: write it here and test it on a Mac by hand, or build it on a Mac through this CLI.

## Open questions

1. Name: `shell` for now (`@agent-socket/shell`); `terminal` or `machine` are the alternatives.
2. Node 22 is the one requirement on the machine. A no-Node `curl | sh` client would need the relay to accept apps over plain HTTP, which isn't in this plan. The menu bar app is the no-Node path on macOS.
3. `gpu-browser` is still on unmerged branches. `shell` doesn't depend on it, so the two can land in either order.
