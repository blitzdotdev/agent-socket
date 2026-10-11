# gpu-browser/test

Unit tests for the GPU browser's boundary checks (`../app/policy.mjs`): `npm run gpu:test:unit` from the repo root.

The end-to-end test (the real server, Chromium and a local relay) is harness scenario 63: `CHROMIUM_PATH=... node harness/run.mjs 63`.
