# Contributing to agent-socket

Bug reports, feature ideas, and pull requests are welcome. The project is small enough that there's no formal process — just a few conventions to make iteration smooth.

## Setup

```bash
git clone https://github.com/teenybase/agentsocket
cd agentsocket
npm install
```

To run the integration harness locally:

```bash
node harness/run.mjs all
```

The harness spawns a real `wrangler dev` for the relay; nothing needs to be running ahead of time. ~50 seconds end-to-end on a typical machine.

To run the chrome-extension unit tests (no chromium required):

```bash
node chrome-extension/test/reconnect.unit.mjs
```

To run the chrome-extension end-to-end (needs `/usr/bin/chromium` or `CHROMIUM_PATH=` set):

```bash
node chrome-extension/test/reconnect.e2e.mjs
```

## Layout

- `relay/` — the Cloudflare Worker (relay + Durable Object). `wrangler.jsonc` is the config of record.
- `sdk/` — `@agent-socket/sdk`, the JS/TS client that registers app-side tool handlers.
- `cli/` — `@agent-socket/cli`, the CLI that ships `channel host` / `channel join` and other tool packs.
- `chrome-extension/` — the MV3 extension that exposes tab-driving tools to any AI chat.
- `examples/` — example app(s) using the SDK (currently just `pixel-art-canvas/`).
- `harness/` — runtime integration scenarios.
- `scripts/` — operational scripts. `deploy.sh` is the single entry point for all wrangler operations.
- `docs/` — design + protocol docs.
- `issues/` — historical / in-flight design notes (separate from GitHub Issues; tracks meta-decisions).

## Conventions

- **No ad-hoc wrangler.** Use `scripts/deploy.sh <subcommand>` for everything (`deploy`, `tail`, `rollback`, `status`, `smoke`, `whoami`, `dev`).
- **`wrangler.jsonc`, not `.toml`.** Comments matter; we keep them.
- **Apache 2.0** license — every commit you make is contributed under that license.
- **One concern per PR.** A bug fix shouldn't bundle a refactor. A doc tweak shouldn't bundle a behavior change.
- **No emojis in code** unless the user asks for them.
- **Commit messages**: short subject line stating what changed; body explaining why (when not obvious). Reference issues in the form `Closes <issue-name>` where the issue lives in `issues/open/`.
- **Tests before merge**: any behavior change needs a harness scenario, unit test, or chrome-ext test exercising the new path.

## What's worth a PR vs. an issue

Open an **issue** for: doc gaps, bug reports, feature ideas, design discussions, threat-model concerns. Use the templates in `.github/ISSUE_TEMPLATE/`.

Open a **PR** when you have a concrete change ready to review. Reference the issue it closes (if any). Small focused PRs land faster than sprawling ones.

## Security

If you find a security issue, **don't open a public issue**. See [`SECURITY.md`](SECURITY.md) for how to report.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). The short version: don't be a jerk.
