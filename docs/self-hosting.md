# Self-hosting

The relay and the registry are separate Cloudflare Workers. You can run the relay without the registry.

You need Node 22+, a Cloudflare account and this repo:

```bash
git clone https://github.com/blitzdotdev/agent-socket
cd agent-socket
npm install
```

## Relay

The relay is a Worker with one Durable Object class and a rate-limit binding. It keeps sessions in memory and stores nothing.

### Run locally

```bash
npm run dev    # wrangler dev on http://localhost:8787
```

Extra arguments go to `wrangler dev`, e.g. `npm run dev -- --port 9000 --ip 0.0.0.0`. To turn on the `/_debug/*` endpoints, copy `relay/.dev.vars.example` to `relay/.dev.vars`.

### Deploy to workers.dev

```bash
cd relay
npx wrangler login
npx wrangler deploy --env=""
```

The relay is then at `https://agent-socket-relay.<your-subdomain>.workers.dev`. `--env=""` selects the top level of `relay/wrangler.jsonc`. Without it wrangler deploys the same thing but warns, because the file also has a `production` environment. That environment holds the routes of the hosted relay at agentsocket.dev; don't deploy it.

For a non-interactive deploy, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead of running `wrangler login` (see `.env.example` for the token scopes).

### Use your own domain

Add a route at the top level of `relay/wrangler.jsonc`. The zone must be on the same Cloudflare account.

```jsonc
"routes": [
  { "pattern": "relay.example.com", "custom_domain": true }
],
```

Then deploy as above.

### Things to check

- `ratelimits[0].namespace_id` (`48001`) must be unique within your Cloudflare account. Change it if another Worker already uses that number.
- Settings are in `vars`: `MAX_SYNC_TOOL_MS`, `HEARTBEAT_TIMEOUT_MS`, `RESUME_GRACE_MS`. See [relay/README.md](../relay/README.md).
- Never set `DEBUG` in `wrangler.jsonc`. It enables endpoints that close other people's sessions.
- The relay does not know its own hostname. Minted links use the base URL the app connected with.

### Point clients at it

- SDK: `connect({ baseUrl: "https://relay.example.com", ... })`.
- Chrome extension: popup, **Settings**, relay URL.

Check it:

```bash
curl -i https://relay.example.com/v1/t/notarealtoken00000/agents.md   # 404 not_found
curl -i https://relay.example.com/v1/_ws                               # 400 protocol_error
```

## Registry

The registry (`registry/`) serves shared per-site tool profiles to the Chrome extension and takes submissions that an admin reviews. It is a Worker plus a D1 database, built with [teenybase](https://www.npmjs.com/package/teenybase), and its admin pages must sit behind Cloudflare Access.

The full steps are in [registry/README.md](../registry/README.md) under "Deploy". In short:

1. In `registry/wrangler.jsonc`, change the `routes` pattern to your domain and make sure the rate-limit `namespace_id` is unique in your account. `workers_dev` stays off, so `/admin` is only reachable through Access.
2. Create a Cloudflare Access application for `<your domain>/admin` and put its team domain and audience tag in `vars.ACCESS_TEAM_DOMAIN` and `vars.ACCESS_AUD`.
3. Put `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_SERVICE_TOKEN` and `IP_HASH_SECRET` in `registry/.prod.vars`.
4. From `registry/`: `npx teeny deploy --remote` (creates the D1 database, applies migrations, deploys), then `npx teeny secrets --remote --upload`.
5. Check `curl https://<your domain>/v1/sites`.
