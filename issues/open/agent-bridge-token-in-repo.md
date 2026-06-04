# agent-bridge: bearer token committed to repo

## What's wrong

`agent-bridge/campaigns.json:5` ships a real-looking bearer token against `https://outreach.app.blitz.dev`:

```json
{
  "slug": "outreach",
  "endpoint": "https://outreach.app.blitz.dev/api/v1/campaigns/...",
  "api_token": "8f4cbb194577faa6a3b8df87d642b10017859e69dffd30f8"
}
```

It looks live. Whether or not it currently authenticates, **this file should never be in the public source tree**. It was added in commit `79897da` ("bridge") and merged to master via the `claude/agent-website-extension-VsA69` branch on 2026-06-04.

Same risk profile applies to anything else under `agent-bridge/` that holds per-deployment secrets.

## Why it matters

- Anyone with read access to the repo (and the eventual `github.com/teenybase/agentsocket` public extraction) sees the token.
- Even if rotated, the token remains in git history forever unless rewritten.
- Pre-launch repo hygiene is on the list — shipping a leaked credential at launch is the worst possible flag.

## What to do

1. **Rotate the token externally**. Whoever owns the outreach campaign on `outreach.app.blitz.dev` should regenerate the API token now, treating the leaked one as compromised.
2. Replace `agent-bridge/campaigns.json` with `agent-bridge/campaigns.example.json` containing a clearly-fake template:
   ```json
   {
     "campaigns": [
       {
         "slug": "outreach",
         "endpoint": "https://your-app.example.com/api/v1/campaigns/...",
         "api_token": "<bearer-token-from-your-app-dashboard>"
       }
     ]
   }
   ```
3. Add `agent-bridge/campaigns.json` and `agent-bridge/config.json` to the repo `.gitignore`.
4. Update `agent-bridge/index.mjs:21` (`loadJson(CAMPAIGNS_PATH, [])`) so the warning logged when the file is missing is clearly actionable.
5. **Optional, depending on rotation urgency:** rewrite git history with `git filter-repo` to remove the token from the historical record. Coordinate with the team before doing this — it rewrites SHAs.
6. Add a short note to `SECURITY.md` "What we'd consider a vulnerability" listing the bridge's required local-config files and that anyone with read access to them can drive the campaign endpoints.

## Acceptance

- `git log -p -- agent-bridge/` and `grep -rE '[a-f0-9]{40,}'` find no live tokens.
- `agent-bridge/campaigns.json` is in `.gitignore`.
- A fresh clone + `node agent-bridge/index.mjs` prints a clear "create your campaigns.json from the example file" error.
- The example file has no real URLs / tokens — only placeholders that look obviously fake.

## Provenance

Caught 2026-06-04 during the post-merge audit (6 parallel reviewers, three of them flagged this independently). The commit message for `79897da` is the one-word "bridge" and made no mention of the secret. The merge into master (`0bb418c`) brought it onto the main branch.
