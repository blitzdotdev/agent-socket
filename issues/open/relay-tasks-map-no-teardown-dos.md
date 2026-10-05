# relay: async `tasks` Map is never cleaned up — memory leak + per-session functional DoS after 100 lifetime async calls

## What's wrong

The Durable Object's `tasks` Map (`relay/src/relay-do.ts:84`) is written but never deleted or cleared anywhere:

- `:367` — a `tool_reply{status:202}` inserts a pending entry (after the `MAX_TASKS_PER_SESSION` cap check at `:363`).
- `:409` — `task_complete` updates the entry with the completed body.
- `:496` — `GET /_as_tasks/<id>` reads the entry, but **never deletes it** after a completed task is consumed.
- `onClose` (`:108-123`) clears `pending` and nulls `appWs`, but **does not touch `tasks`**.

There is no TTL, no alarm-based sweep, and no delete-on-read. Combined with the cap check:

```ts
if (this.tasks.size >= MAX_TASKS_PER_SESSION) {        // :363, MAX = 100
  p.resolve(errorResponse("too_many_tasks", ...503))
  return
}
this.tasks.set(msg.taskId, { status: 0, body: undefined, completed: false })  // :367
```

…the cap counts **lifetime** tasks, not currently-pending ones.

## Why it matters

Two distinct problems:

1. **Functional DoS.** After a session has created 100 async tasks *cumulatively* — even if every one was long since polled, completed, and consumed — `tasks.size` stays at 100 and every subsequent async tool call fails with `503 too_many_tasks` for the rest of the session. A long-lived host (the channel host is explicitly "persistent for the host's session") permanently bricks its async path after 100 cumulative async calls. This is silent and irreversible without a reconnect.

2. **Memory leak.** Up to `MAX_TASKS_PER_SESSION (100) × MAX_TASK_BODY_BYTES (64 KB) ≈ 6.4 MB` of completed-task bodies sit pinned in the non-hibernating DO (`static options = { hibernate: false }`, `:70`) for the DO's entire lifetime, readable forever at their `/_as_tasks/<id>` URLs with no single-read consumption.

## What to do

- Delete a completed task from `tasks` after it is read (`GET /_as_tasks/<id>` returns a `completed` task → `tasks.delete(taskId)`), or expire entries on a short TTL via a DO alarm.
- Clear `tasks` in `onClose`.
- Make the cap count **pending** tasks, not lifetime tasks (decrement/remove on completion+read), so the async path doesn't brick.

## Acceptance

- A session can run far more than 100 async calls over its lifetime as long as it doesn't have >100 *simultaneously pending*.
- After an agent polls a completed task, the entry is gone (a second poll returns 404, and the slot is freed).
- `onClose` leaves `tasks` empty.

## Provenance

Found during a full line-by-line audit. Verified every `tasks` access site: writes at `:367`/`:409`, the only read at `:496`, and no `delete`/`clear` anywhere in the file (including `onClose`). The async-task body/status/id *validation* caps (filed and closed) are correct — this is a separate lifecycle defect, not a gap in those caps.
