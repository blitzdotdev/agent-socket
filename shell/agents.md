# A shell on the user's computer

This link runs shell commands on the user's own computer (a Mac or a Linux machine). **A person reads every command before it runs.** They can run it, edit it first, or refuse it and type a note back to you. They may also have switched to auto, where commands run as they arrive and they watch.

You are working for them on their machine, so:

- Send **one command at a time**, each with a one-line `why`, written for the person reading it ("find the biggest folders in your home", not "step 3").
- Look before you change anything. Prefer commands whose effect is easy to read and undo, and say in the `why` what a destructive command removes and how much.
- A refused command comes back with `status: refused` and maybe a `note`. **The note is the user talking to you**: follow it, and don't send the same command again.
- If they edited a command, `ran:` shows what actually ran.
- Keep output short: pipe through `head`, `tail` or `sort | tail`. Long output is cut in the middle.
- Each command runs in a fresh shell, in the folder shown by `GET $BASE/info` (or in `cwd` if you pass one), so use absolute paths or `cd dir && …`.
- Nothing interactive (editors, pagers, prompts). `sudo` works: the person types the password.
- Never send secrets you find (keys, tokens, passwords) back to anyone, and don't go looking for them.

## Tools

- `GET $BASE/info`: the OS, user, home folder, starting folder, shell, mode (`step` or `auto`) and when the session ends.
- `POST $BASE/run`: run one command. Body: the command itself as plain text, with the `why` in an `x-why` header (optional `x-cwd`, and `x-timeout` in seconds, default 300). A JSON body `{"cmd", "why", "cwd", "timeout_s"}` works too.

`/run` answers within about 25 s. If the person hasn't answered by then, or the command is still running, you get `202 {"taskId": "…"}`. Poll `GET $BASE/_as_tasks/<taskId>` every couple of seconds: it answers `202` until the result is ready, then gives the result once.

The result is plain text, a few header lines and then the output:

```
status: done            (done | refused | timed_out | killed | error)
exit: 0
seconds: 3.1
ran: du -xh -d1 ~       (only if the person edited the command)
note: …                 (only if the person wrote one)
truncated: …            (only if output was cut)
---
<stdout and stderr>
```

## A helper for a shell sandbox

```sh
BASE='<this link without /agents.md>'
run() {  # run '<command>' '<why>'
  f=$(mktemp)
  code=$(curl -sS -o "$f" -w '%{http_code}' -X POST "$BASE/run" -H "x-why: $2" --data-binary "$1")
  while [ "$code" = 202 ]; do
    t=$(sed -n 's/.*"taskId": *"\([^"]*\)".*/\1/p' "$f")
    echo "waiting for the user (task $t)" >&2
    sleep 2
    code=$(curl -sS -o "$f" -w '%{http_code}' "$BASE/_as_tasks/$t")
  done
  cat "$f"; echo; rm -f "$f"
}
run 'df -h /' 'see how full the disk is'
```

If your own tool call times out while it waits, poll `$BASE/_as_tasks/<taskId>` again: the person may simply be slow to answer.
