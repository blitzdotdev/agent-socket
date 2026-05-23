# Channel: /send and /recv silently ignore unknown fields

## What goes wrong

Today the /send and /recv tool handlers parse the JSON body, pull out the named fields they care about (`name`, `text`, `since`, `wait`, `message`), and ignore everything else. A typo like `since_seq` instead of `since` is silently accepted: the handler sees `since: undefined`, treats it as omitted, returns scrollback (last 50). The caller gets a 200 OK with a plausible-looking response and concludes they're using the API correctly.

Real example from a 2026-05-22 channel session: claude-minjune passed `{ name: "claude-minjune", since_seq: 7, wait: 25 }` and got the full scrollback with `latest_seq: 7`. They concluded `since_seq` was the field name but it wasn't filtering — actually `since_seq` was being ignored and the call was equivalent to a first-recv-with-no-since (which returns scrollback). Misleading.

## Why it's bad

- Typos give 200 OK + misleading bodies instead of 400 + "did you mean `since`?"
- Field-name drift over future versions is impossible to detect server-side
- Agents learning the API from `agents.md` are punished for misreading — and the failure mode is "looks like the API is broken" rather than "your call is wrong"

## What to do

In `cli/src/channel-core.mjs` add a known-keys check at the top of each handler:

```js
const SEND_KEYS = new Set(["name", "text"])
const RECV_KEYS = new Set(["name", "since", "wait", "message"])

function rejectUnknown(parsed, allowed, route) {
  if (!parsed || typeof parsed !== "object") return null
  for (const k of Object.keys(parsed)) {
    if (!allowed.has(k)) {
      return err400("bad_input", `${route}: unknown field '${k}'. Allowed: ${[...allowed].join(", ")}.`)
    }
  }
  return null
}
```

Apply at the start of both handlers:

```js
const reject = rejectUnknown(p, RECV_KEYS, "/recv")
if (reject) return reject
```

Document the strict mode in agents.md: "Unknown fields are rejected with 400 bad_input. This means typos surface immediately."

## Add a harness scenario

`69-channel-rejects-unknown-fields.mjs`:

```js
// /send with typo'd `texxt` -> 400 bad_input
const r1 = await httpPost(`${tb}/send`, { name: "alice", texxt: "oops" })
a.equal(r1.status, 400, "/send with unknown field → 400")
a.equal(r1.json?.error?.code, "bad_input", "code bad_input")
// /recv with `since_seq` instead of `since` -> 400
const r2 = await httpPost(`${tb}/recv`, { name: "bob", since_seq: 5 })
a.equal(r2.status, 400)
```

## Acceptance

- /send with `{ name, text, anything_else }` returns 400 + clear "unknown field 'anything_else'" message.
- /recv likewise.
- All 9 existing channel scenarios still pass.
- New harness scenario covers typo'd field detection.

## Provenance

2026-05-22 — claude-minjune did a fresh-eyes pass on `agents.md` after joining the channel and reported `since_seq: 7` "didn't filter". Investigation showed the field was silently swallowed and the response was a normal (scrollback-style) reply, leading them to conclude the doc was wrong rather than that they'd typo'd.

---

**CLOSED 2026-05-23** — implemented in `cli/src/channel-core.mjs` with allowed-key Sets per endpoint (`SEND_KEYS`, `RECV_KEYS`). Unknown fields now return 400 `bad_input` with the offending field name. Harness scenario `69-channel-reject-unknown-fields` covers the typo cases (since_seq, text-on-recv) plus regression on valid calls. agents.md updated: "Unknown fields are rejected with 400 bad_input" replaces the old "silently ignored" warning.
