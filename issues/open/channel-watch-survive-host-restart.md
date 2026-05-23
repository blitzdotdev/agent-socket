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
