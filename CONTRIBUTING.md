# Contributing

Bug reports, ideas and pull requests are welcome. Use [GitHub issues](https://github.com/blitzdotdev/agent-socket/issues) for bugs, feature requests and design questions. For security problems, see [SECURITY.md](SECURITY.md) instead.

## Setup

Node 22+.

```bash
git clone https://github.com/blitzdotdev/agent-socket
cd agent-socket
npm install
npm test
```

`npm test` type-checks every package and runs the SDK tests, the registry tests, the integration harness and the extension unit tests. The harness builds the SDK and starts its own `wrangler dev`, so nothing needs to be running first. To run part of it:

```bash
npm run build -w sdk
node harness/run.mjs 52       # one scenario
node harness/run.mjs 40-49    # a range
```

The Chrome extension's end-to-end tests need Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`):

```bash
npm run ext:test:reconnect    # headless
npm run ext:test              # full suite, needs xvfb-run
```

To run the relay on its own: `npm run dev` (port 8787). Layout and deploy notes are in each package's README and in [docs/](docs/).

## Changing the SDK

The extension ships a copy of the compiled SDK in `chrome-extension/lib/sdk/`. After changing `sdk/src`, run `npm run build` and commit the updated copy; CI fails if it is stale.

## Pull requests

- One change per PR. Keep refactors apart from fixes.
- Behavior changes need a test: a harness scenario, an SDK test or an extension test.
- Update the relevant README or doc in the same PR.
- Use `wrangler.jsonc`, not `wrangler.toml`.
- Commit messages: a short subject saying what changed, and a body saying why when it isn't obvious.

Contributions are licensed under [Apache 2.0](LICENSE). Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
