# Channel: `channel watch` should survive a host restart

## What goes wrong

`channel watch` uses `fs.watch(PATHS.log, ...)` to tail messages. When the host process restarts:

1. `resetChannelRoot()` does `fs.rmSync(CHANNEL_ROOT, ...)` — deletes `log.jsonl` (and its inode).
2. Then `fs.writeFileSync(PATHS.log, "")` creates a new file (different inode).
3. The existing `fs.watch` was bound to the old inode/path; depending on platform it either fires a final "unlink" event or silently stops firing.
4. The `watch` CLI process keeps running but is deaf to the new file.

End result: a `channel watch` that worked correctly until the moment a `channel host` was restarted, then went silently broken. Caller has no signal that the watcher is no longer functional.

## Acceptance

- `channel watch` survives any number of `host` restarts and continues emitting messages from the freshly-created `log.jsonl`.
- If the host is fully gone (not just restarting), `watch` should print a clear message and exit non-zero rather than hanging silently.

## Possible fixes

- Re-arm `fs.watch` on the parent directory and re-bind to `log.jsonl` when it reappears (use `fs.watch(PATHS.root, ...)` to detect file recreation).
- Or poll-based fallback: stat the file every 200ms; on inode change, reseek and resume.
- Add a sentinel: if `info.json` disappears, treat the host as fully gone and exit.

## Provenance

Discovered 2026-05-21 while restarting the channel host to apply new docs. The bound monitor went silent without indicating anything was wrong, and the host did not signal anything either. The fix required manually stopping and re-arming the monitor — fine in interactive use, broken for any "leave watch running indefinitely" pattern.

---

**CLOSED 2026-05-28** — fix landed in `cli/src/channel-recv.mjs`'s
`createResilientWatcher`, verified end-to-end by 3-agent investigation +
harness scenario 70.

### What didn't work (false starts)

1. Parent-directory `fs.watch` for rename events — survives ONE restart but
   dies on the next, because the parent dir itself (`~/.agent-socket/current/`)
   is `rm -rf`'d each restart.
2. Inode-change detection — silently fails when the Linux kernel reuses
   the just-freed inode (observed empirically: same inode `1585408` before
   and after `rm + recreate`).
3. Content-based "first msg seq==1 with cursor past 1" check — caused an
   infinite loop because the check kept firing on every subsequent poll
   (cursor reset to 0, drain emits, cursor advances, next poll sees
   firstMsg.seq===1 again, resets again, …).

### What works (final design)

Pure stat-poll, 250ms tick, three orthogonal signals:

- **inode change** → restart → reset cursor + rearm watcher + drain
- **size DECREASE** → restart (handles inode-reuse + truncate)
- **size grew OR mtime changed** → content appended → drain only

No fs.watch dependence for correctness (fs.watch is kept as a fast-path
optimization for sub-250ms latency — but the watcher is bound to a
potentially-dead inode; the poll is the source of truth).

### Verification

- Manual: 3 consecutive `kill host && restart` cycles + 1 final message
  on the last host. All 5 messages reach watch, no duplicates.
- Harness `70-channel-watch-survives-host-restart` spawns real host +
  watch child processes, kills + restarts the host twice, asserts (a)
  each post-restart message reaches watch, (b) no duplicate emissions.
- Harness regression: 40/40 scenarios still green; chrome-ext unit test
  21/21 still green.
- Debug helper: `AS_DEBUG_WATCHER=1` env enables stderr lines tracing
  the poll decisions ("first sighting, ino=…", "restart detected, …").
