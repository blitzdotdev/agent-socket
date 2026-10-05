# relay: per-IP WebSocket rate limit doesn't bite in production

`/v1/_ws` calls `env.WS_RATE_LIMIT.limit({ key: cf-connecting-ip })` (100 per 10 s). Locally (miniflare)
scenario 90 sees 429s. Against agentsocket.dev on 2026-10-05, 240 upgrades from one IP in 8 s (paced
30/s, alternating LHR/AMS colos) all got 101; a 200-connection burst also got no 429.

Cloudflare documents the binding as "permissive, eventually consistent… not an accurate accounting
system", counted per location. So it is not a dependable abuse control at this scale.

Options: accept it as best-effort and say so in SECURITY.md; or count upgrades in a Durable Object
keyed by IP (exact, but one more DO hop per new session); or a WAF rate-limiting rule on
`/v1/_ws` (zone-level, exact enough, no code).
