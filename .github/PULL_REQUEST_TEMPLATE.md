## What this PR does

(One sentence.)

## Why

(What was broken / missing / unclear. Reference the issue if there is one.)

## Notes for the reviewer

- [ ] Affects: relay / SDK / CLI / chrome-ext / harness / docs
- [ ] Tests: which harness scenarios or unit tests cover the new behavior?
- [ ] Deploy: does this change need a relay redeploy? (Worker-side code changes do; SDK/CLI/extension changes don't.)
- [ ] Closes issue: `issues/open/<name>.md` (if applicable)

## Checklist

- [ ] `npm test` passes locally
- [ ] No new ad-hoc `wrangler` invocations — everything goes through `scripts/deploy.sh`
- [ ] No new TOML files — used `wrangler.jsonc` if needed
- [ ] No secrets / API tokens in the diff
- [ ] Updated relevant README / CHANGELOG / docs
