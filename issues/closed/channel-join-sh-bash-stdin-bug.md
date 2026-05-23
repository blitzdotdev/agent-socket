# Channel: `curl | bash` join one-liner exited instantly

## What went wrong

The original one-liner I documented and printed in the host's startup banner was:

```bash
curl -s URL/join.sh | jq -r .script | bash -s -- "" "<name>"
```

That **doesn't work for an interactive client**. Reason: in `bash -s`, bash reads its script from stdin — which is being piped from `jq`. By the time the script reaches its `while IFS= read -r line` loop (the foreground stdin reader that lets the human type), stdin is already consumed and at EOF. The loop exits immediately, triggers cleanup, and the script terminates.

User reported "pasted in chat - it exited instantly" 2026-05-22. Two `cleanup` messages landed (perhaps from the AI environment writing into the brief poll-loop window before exit), then nothing.

## Root cause

Using stdin both as the script source AND as the interactive input stream is incompatible. You can only do one.

## Fix

Switch to **process substitution**:

```bash
bash <(curl -s URL/join.sh | jq -r .script) "" "<name>"
```

`bash <(...)` runs bash with the script content from a /dev/fd FIFO. Bash's stdin remains the user's terminal, so the foreground `while read` loop receives actual keystrokes.

This works in bash 4+ on macOS, Linux, WSL. Doesn't work in dash/posh/sh. That's fine — the script itself is bash-only too (uses `set -uo pipefail`, `${var:-default}`, etc.).

## What changed

- `cli/src/join-sh-template.mjs` — docstring updated to recommend the process-substitution form. Removed an attempted `/dev/tty` defensive redirect that was harmful in headless contexts (printed `/dev/tty: No such device or address` to stderr).
- `cli/src/channel-host.mjs` — startup banner now prints the `bash <(curl | jq)` form and explains why the `curl | bash` form is broken.
- `cli/README.md` — Scenario 1 rewritten with the correct invocation; added an explicit "Why not `curl … | bash`?" callout.

Verified end-to-end: piped `echo "clean-fix test"` into the process-substituted bash, message landed in the host's log under the test name.

## Provenance

2026-05-22. Found by the user pasting the one-liner I'd put in the banner; their chat reported "it exited instantly". The bug had been in the recommended pattern from the moment `/join.sh` was added the previous day, but was only exercised by a human-on-real-terminal user — every smoke test I'd run was either headless (so the bug was invisible) or used `agent-socket channel join` (the node CLI, which doesn't share the stdin-conflict issue).
