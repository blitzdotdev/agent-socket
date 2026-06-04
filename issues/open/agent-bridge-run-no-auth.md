# agent-bridge: `/run` and `/cancel` have no auth beyond URL secrecy → RCE on the bridge host

## What's wrong

`agent-bridge/tools.mjs:52` registers a `/run` tool that spawns a local AI harness with arbitrary user-supplied prompts:

```js
{
  path: "/run",
  description: "Spawn the configured local AI harness with the supplied prompt.",
  handler: async ({ body }) => {
    const { prompt, tag, timeout_ms } = JSON.parse(body)
    return startHarness({ prompt, tag, timeout_ms })
  },
}
```

`startHarness` in `harness.mjs:30-60` resolves a binary path from a hard-coded allowlist (`claude`, `codex`, `cursor`) and runs it with the prompt as an argv. For `claude`, the command line is:

```
claude --dangerously-skip-permissions <prompt>
```

The bridge mints a single paste-able agent-socket URL and fans it out to N campaigns. Anyone who learns the URL — via campaign config leak, relay log capture, browser-history exfil, social engineering — can POST `{prompt: "rm -rf ~/Documents"}` to `/run` and the bridge will dutifully spawn `claude --dangerously-skip-permissions "rm -rf ~/Documents"`. The user's Claude install with full disk access is then steerable by whoever has the URL.

Currently the only "auth" is the URL secrecy assumption: agent-socket v0 has no per-tool auth, by design, because URLs are supposed to be DM-grade secrets. That's a defensible posture for sandboxed-in-the-browser tools like the chrome extension. It is **not** a defensible posture for "spawn a privileged AI agent with full disk access on someone's laptop."

## Why it matters

- The bridge is meant to run as a launchd service (`scripts/install-launchd.sh`), so it runs constantly with the user's full permissions.
- `--dangerously-skip-permissions` explicitly bypasses Claude's safety prompts — the harness has no human in the loop.
- The mint URL is "the only secret," but the bridge fan-outs it to multiple HTTPS endpoints (`fanoutBridgeUrl`). Every endpoint must be trusted, OR a malicious campaign endpoint can learn the bridge URL and drive the bridge.
- The bridge's docstring (`index.mjs:1-9`) makes no mention of this trust model.

## What to do

Pick one or more layered defenses. Recommended: defense-in-depth.

### 1. Bridge-side shared secret

Require a `X-Bridge-Auth: <token>` header on every `/run` and `/cancel` request:

- Generate a per-install secret at `install-launchd.sh` time, stored in `~/.config/agent-bridge/secret` with `chmod 600`.
- Bridge reads the secret on startup; rejects any `/run` / `/cancel` whose `X-Bridge-Auth` doesn't match (constant-time compare).
- Fanout `bot_config.agent_bridge_url` continues to use the mint URL alone; campaigns sign their requests with the secret via Bearer or custom header.
- The mint URL alone is no longer enough to drive the bridge — the caller also needs the secret, which never leaves the user's machine and the campaign service.

This breaks the "any AI chat can hit a paste URL" affordance, which is fine — the bridge isn't meant to be used by random chat windows, only by trusted campaigns. The chrome-extension's affordance is unchanged.

### 2. Prompt allowlist or templating

Don't accept arbitrary prompts. The caller picks a `template_id` and supplies variables; the bridge interpolates into a stored template. The template defines what the harness can do.

This narrows blast radius from "any RCE-equivalent" to "what the template lets the agent do."

### 3. Drop `--dangerously-skip-permissions`

The harness can ask permission per filesystem write. Slower, more friction, but the human is back in the loop.

### 4. Document the trust model clearly

If the answer is "we're shipping as-is for v0," then `agent-bridge/README.md` (which doesn't exist yet) must say: "Treat the bridge URL as a credential equivalent to your shell — anyone with it can run arbitrary AI agents on your machine with full filesystem access."

## Acceptance

- POST to `/run` without the expected auth header returns 401, doesn't spawn anything.
- POST to `/run` with the expected auth header still works for legit campaigns.
- A short security note in `SECURITY.md` documents the bridge trust model and the auth requirement.
- `install-launchd.sh` generates the per-install secret and surfaces it (and a one-line "save this; campaign endpoints need it" instruction) to stdout.

## Provenance

Caught 2026-06-04 during the post-merge audit. Pre-existing in commit `79897da`. The bridge author left a `TODO: why every? any risk of this invalidates existing session of old campaign` at `agent-bridge/index.mjs:51` about a related concern (URL fanout invalidation), but the auth gap on `/run` itself isn't flagged anywhere in the committed code.
