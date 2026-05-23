# Chrome extension: flip hardcoded `agentsocket.dev` default to `aisocket.dev` on merge

## Context

The branch `claude/agent-website-extension-VsA69` adds a full chrome extension under `chrome-extension/`. It's an agent-socket app (not a channel client) — registers tools that drive the active tab. The extension is currently unmerged into master.

The extension hardcodes the canonical brand URL `https://agentsocket.dev` as its default relay base in three places:

| File | Line | What |
|---|---|---|
| `chrome-extension/background.js` | 24 | `const DEFAULT_BASE = "https://agentsocket.dev"` |
| `chrome-extension/lib/as-client.js` | 17 | `const DEFAULT_BASE = "https://agentsocket.dev"` (the extension's own slim re-implementation of the SDK) |
| `chrome-extension/README.md` | 57 | "default is `https://agentsocket.dev`" |

But the relay is currently deployed only at `aisocket.dev` — `agentsocket.dev` isn't acquired yet. If the extension lands on master and gets distributed (e.g. via chrome web store, dev-mode side-load) without an updated default, users who don't open the popup settings get a default URL that fails DNS resolution.

## What to do

Before merging the branch (or as a follow-up commit immediately after), flip the default in all three places with the same "temporary" comment pattern we used in `sdk/src/session.ts`:

```js
// Temporary — using aisocket.dev until the brand domain agentsocket.dev is
// acquired and routed to the same Worker. Flip back when that lands.
const DEFAULT_BASE = "https://aisocket.dev"
```

And one-line edit in the README's "Install" section.

## Acceptance

- All three references use `aisocket.dev` with the temporary comment.
- A fresh chrome-extension install (no settings touched) connects successfully to the deployed relay without user intervention.
- When `agentsocket.dev` is acquired, all three references flip back to that URL in a single follow-up commit alongside the SDK + wrangler.toml route additions.

## Provenance

2026-05-23 — caught while planning the merge of the chrome-extension branch into master, after the relay's first prod deploy went to `aisocket.dev`. The deploy was intentionally to aisocket.dev as a temporary URL (brand domain not yet acquired), so any client hardcoding the brand URL inherits the same temporary-flip problem the SDK already addressed.

---

**CLOSED 2026-05-23** — fixed without code change. We acquired `agentsocket.dev`
the same day the issue was filed, added it as the canonical route alongside
aisocket.dev (now an alias). The chrome extension's hardcoded
`https://agentsocket.dev` default is correct as-is; no flip needed at merge time.
