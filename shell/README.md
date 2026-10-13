# Shell

Let an agent anywhere (a cloud Claude session, a chat with a code sandbox, anything that can make HTTPS calls) run shell commands on your machine through an agent-socket link. **Every command shows up in your terminal first, and runs only when you press Enter.** No agent installed on your machine, no SSH, and no copy-pasting commands and output between the chat and a terminal.

```bash
npx @agent-socket/shell
```

It prints a link and copies it to the clipboard. Paste it into the agent's chat and say what you want ("my disk is almost full, find what's using it and help me clean up"). Each command the agent sends waits in the terminal:

```
── 2 · 14:02:11 ──────────────────────────────
why: remove the old Xcode build products (31 GB)
$ rm -rf ~/Library/Developer/Xcode/DerivedData
Enter run · n refuse · e edit and run · a auto · q end
```

| Key | |
|---|---|
| Enter | Run it. The output shows here and goes back to the agent. |
| `n` | Refuse it. You can type a note, and it goes to the agent ("keep that, look at Docker instead"). |
| `e` | Edit it, then run what you typed. The agent is told what actually ran. |
| `a` | Auto: from now on commands run as they arrive, still shown here. `s` (between commands) goes back to step. |
| `q`, Ctrl-C at the prompt | End the session. The link stops working at once. |
| Ctrl-C while a command runs | Stop that command, as in any terminal. The session goes on. |

The link lasts 60 minutes (`--for 2h`, `--for none`). `--relay URL` uses a self-hosted relay. Needs Node.js 22 or newer, on macOS or Linux.

## How commands run

- Each command runs in a fresh `$SHELL -c`, as you, with your environment, starting in the folder you started the CLI in (or the `cwd` the agent asks for).
- The terminal is the command's while it runs: `sudo` asks you for your password here, and so does anything else that prompts.
- A command times out after 300 s unless the agent asks for another limit; a timeout stops it and everything it started.
- As in a terminal, Ctrl-C doesn't stop a command's background jobs (`cmd &`). They keep running after the command returns, and their output isn't captured.
- Output going back to the agent has terminal escapes removed and is cut in the middle if it's long (about 48 KiB is kept), to fit the relay's limit for one result.

The command and the reason come from the agent, so control, bidi and zero-width characters in them are shown as visible escapes (`\u{1b}`) with a warning, never sent to your terminal: what you read is what runs.

## What the agent sees

The link's `agents.md` ([agents.md](agents.md)) explains it to the agent. Two tools:

| Tool | |
|---|---|
| `GET /info` | OS, user, home, starting folder, shell, mode, when the session ends. |
| `POST /run` | The command as the body (plain text, the reason in an `x-why` header, optional `x-cwd` and `x-timeout`), or JSON `{cmd, why, cwd, timeout_s}`. |

`/run` answers within about 25 s. If you haven't answered by then, or the command is still running, the agent gets `202` with a task id and polls `/_as_tasks/<id>` for the result. The result is plain text: `status:` (`done`, `refused`, `timed_out`, `killed` or `error`), `exit:`, `seconds:`, `ran:` (if you edited it), `note:` (if you wrote one), `truncated:` (if output was cut), then `---` and the output. `agents.md` includes a small `run` shell function that does the call and the polling.

## Security

- While the CLI runs, the link is a way to run commands on your machine, gated by you at the terminal. In step mode nothing runs without a key press; auto is your choice, and you see every command.
- The link is a bearer credential: anyone who has it can send commands (which you still approve). It dies when the session ends.
- On agentsocket.dev the relay sees commands and their output in plaintext after TLS. [Self-host the relay](../docs/self-hosting.md) if that matters.

## Development

```bash
npm install && npm run build                  # builds the SDK and vendors it into shell/lib/sdk
node shell/bin/agent-socket-shell.mjs --relay http://127.0.0.1:8787
node harness/run.mjs 64                       # end to end, in a pseudo-terminal, against a local relay
```

The SDK in `lib/sdk/` is copied from `sdk/dist/` by `scripts/vendor-sdk.sh` (part of `npm run build`).
