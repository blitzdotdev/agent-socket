# `@agent-socket/registry`

Hosted registry of **site profiles** for the agent-socket Chrome extension: per-website notes plus ready-made tools (`{path, method, description, input_schema, code}`) so an AI driving a tab doesn't have to rediscover how a site works. Anyone (in practice: an AI, through an extension tool) can submit a profile; nothing goes live until the owner approves it in the admin UI.

It's a Cloudflare Worker + D1 built with [teenybase](https://www.npmjs.com/package/teenybase): the schema lives in [`teenybase.ts`](./teenybase.ts) and migrations are generated from it (never hand-written).

## Data model

| Table | What |
|---|---|
| `sites` | One row per host: `host` (unique), `notes` (markdown), live `version`, `status` (`published`/`unpublished`), `tool_count`, `tool_index` (search text). FTS5-indexed over host, notes, tool paths and descriptions. |
| `site_versions` | Append-only history: one row per approved version (notes, payload hash, approving submission, approver). |
| `tools` | Tool definitions per `(site, version, method, path)`; old versions are kept. `disabled` = unpublished by an admin. |
| `site_aliases` | `alias` → `host` (e.g. `twitter.com` → `x.com`). A leading `www.` is also stripped automatically. |
| `site_stats` | Use counter per site (kept apart so GET traffic doesn't touch the FTS index). |
| `submissions` | Proposed profiles: `payload` (full profile JSON), `status` (`pending`/`approved`/`rejected`), `kind`, `review_note`, reviewer + timestamps, `base_version`, and submitter info (HMAC'd IP, user agent, extension version). |

Approving a submission writes the new `sites` row/version, its `site_versions` row and all its `tools` in **one D1 batch** (a single transaction). Unique constraints make concurrent approvals or an approve racing a reject abort the whole batch instead of half-applying.

The special host `*` holds the generic fallback profile.

## Public API (JSON, CORS `*`)

| Endpoint | |
|---|---|
| `GET /v1/sites/:host` | Approved profile: `{host, requested_host, version, updated, notes, tools: [{method, path, description, input_schema?, code}]}`. Resolves aliases and `www.`. 404 if none / unpublished. |
| `GET /v1/sites` | All published hosts with version, tool count and aliases. |
| `GET /v1/search?q=&limit=` | Full-text search (hosts, notes, tool paths, descriptions). Returns `{host, version, tool_count, summary, tools, matched_tools}` per hit. |
| `POST /v1/submissions` | Anonymous submission `{host, notes?, tools: [...], ext_version?}` → `201 {id, status: "pending"}` (`200 … duplicate: true` if an identical submission is already pending). Never auto-approved. |

Submission rules (see [`src/rules.ts`](./src/rules.ts)): host must be a public DNS name (no scheme/port/IP) or `*`; tool paths must match `^/[a-zA-Z0-9_\-/.]+$` and may not be relay-reserved (`/agents.md`, `/tools.json` and anything under them, `/_as_*`) or one of the extension's built-in tool paths (`/eval`, `/click`, …). The path rules mirror `relay/src/relay-do.ts` — change both together. Unknown fields are rejected. Caps: body 256 KB, notes 16 KB, ≤ 50 tools, code 32 KB, description 4 KB, input_schema 16 KB. Errors: `400 invalid_submission` (with `issues[]`), `409 no_changes` (identical to live), `413`, `415`, `429 rate_limited`, `503 queue_full`.

Abuse limits: a Workers Rate Limiting binding (`SUBMIT_LIMITER`, 5/min per IP hash per Cloudflare location) plus an exact D1 cap (`SUBMISSIONS_PER_IP_PER_DAY`, default 20) and a global cap on pending submissions (`MAX_PENDING_SUBMISSIONS`, default 500). IPs are stored only as `HMAC(IP_HASH_SECRET, ip)`.

teenybase's own `/api/v1/*` routes exist too (health, migrations for the CLI). Its generic table CRUD is admin-only for every table (published `sites` rows are readable).

## Admin (`/admin`)

Server-rendered, no JS, no third-party requests.

- **Review queue**: filter by status/host; each row shows changes vs the live version and risk flags.
- **Submission page**: line + word-level diff of notes and every tool's description, input schema and **code** against the live version, risky patterns highlighted (`fetch(`, `XMLHttpRequest`, `sendBeacon`, `document.cookie`, `localStorage`, `eval(`, `new Function`, dynamic `import()`, base64/charcode obfuscation, `chrome.*`, …) and an "acts for user" flag for tools that post/send/delete. Approve (optional note) / Reject (reason required).
- **Sites**: all sites with version, live/disabled tool counts, aliases, pending count, uses; per-site page with full profile, version history, version-to-version diffs, unpublish/republish site, unpublish/re-enable single tools, manage aliases.

### Auth

`/admin` must sit behind a **Cloudflare Access** application. The worker also verifies the `Cf-Access-Jwt-Assertion` header on every admin request (defense in depth): RS256 signature against `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (cached, refetched on unknown `kid`), `iss`, `aud` = `ACCESS_AUD`, `exp`/`nbf`. Missing config fails closed (500). State-changing requests are also rejected if `Origin` is another site. The reviewer's Access email (or service-token name) is recorded on each decision.

`DEV_BYPASS_ACCESS=1` skips the check **only** when the request host is `localhost`, `127.0.0.1` or `*.localhost`, so a stray env var can't open production. Never set it in `wrangler.jsonc`.

## Local development

```bash
npm install                      # from the repo root (registry is a workspace)
cd registry
cp .dev.vars.example .dev.vars
npm run migrate                  # teeny deploy --local: generate + apply migrations from teenybase.ts
npm run dev                      # teeny dev on 0.0.0.0:8795 (see wrangler.jsonc "dev")
npm run seed                     # import registry/seed/ as PENDING submissions
npm run seed -- --approve-trusted   # …and publish github.com, news.ycombinator.com, docs.google.com, * directly
npm test                         # vitest in workerd (@cloudflare/vitest-pool-workers)
npm run check                    # tsc
```

Admin: <http://localhost:8795/admin>. After changing `teenybase.ts`, run `npm run migrate` and restart `npm run dev`. The seed is idempotent: live content is skipped, identical pending submissions are reused. Twitter/Reddit/X profiles are never auto-approved; some of their tools post, reply or send DMs.

Tests generate migrations straight from `teenybase.ts`, so they never depend on the local `migrations/` directory (gitignored, like every teenybase project).

## Deploy (owner)

Deployed at https://registry.agentsocket.dev (Access team `blitz-dev-box`). To deploy your own:

1. **Login**: `npx wrangler login` (no `account_id` in `wrangler.jsonc`; set `CLOUDFLARE_ACCOUNT_ID` if you have several accounts).
2. **Rate-limit namespace**: `ratelimits[0].namespace_id` (`47001`) must be unique in the account; change it if it collides.
3. **Cloudflare Access** (Zero Trust dashboard → Access → Applications → Add → Self-hosted):
   - Domain `registry.agentsocket.dev`, path `admin` (covers `/admin/*`). Leave `/v1/*` public.
   - Policy: Allow → your email(s). For the seed script against prod, also add a **Service Auth** policy with a new service token.
   - Copy the **Application Audience (AUD) Tag** and your team domain (`<team>.cloudflareaccess.com`) into `wrangler.jsonc` `vars.ACCESS_AUD` / `vars.ACCESS_TEAM_DOMAIN`.
4. **Secrets**: create `.prod.vars` (gitignored) with strong values for `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_SERVICE_TOKEN`, `IP_HASH_SECRET` (no `DEV_BYPASS_ACCESS`).
5. **Database + deploy** (on later redeploys, back up first: `npx teeny backup --remote`): `npx teeny deploy --remote` (pick your own Cloudflare account, not Teenybase Cloud, if asked) runs `wrangler d1 create agent-socket-registry` for the `TEENY_AUTO_CREATE` placeholder and writes the real `database_id` into `wrangler.jsonc`, applies migrations and deploys. Then `npx teeny secrets --remote --upload`. Commit the updated `database_id`.
6. **Domain**: `routes` has `registry.agentsocket.dev` as a custom domain (the zone must be on the account). `workers_dev`/`preview_urls` are off so the admin isn't reachable around Access.
7. **Seed prod** (optional): `CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… node scripts/seed.mjs --url https://registry.agentsocket.dev [--approve-trusted]`.
8. Check: `curl https://registry.agentsocket.dev/v1/sites`, then open `/admin` (Access login).

## Layout

```
teenybase.ts         schema (tables, FTS, rules) — source of truth for migrations
wrangler.jsonc       worker config (D1, rate limit, vars, route)
src/index.ts         teenyHono app: /api (teenybase), /v1, /admin
src/api.ts           public JSON API
src/rules.ts         submission validation (mirrors relay tool-path rules)
src/store.ts         D1 access (rawSQL / one-batch approve)
src/access.ts        Cloudflare Access JWT verification
src/admin/           SSR admin (hono/jsx)
src/diff.ts, compare.ts, risk.ts   review helpers
scripts/seed.mjs     import seed/ (the starter profiles)
seed/                starter site profiles (_index.json maps hosts/aliases to files)
test/                vitest-pool-workers tests
```
