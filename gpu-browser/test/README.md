# gpu-browser/test

Unit tests for the GPU browser's boundary checks (`../app/policy.mjs`): `npm run gpu:test:unit` from the repo root.

The end-to-end test (the real server, Chromium and a local relay) is harness scenario 63: `CHROMIUM_PATH=... node harness/run.mjs 63`.

`install-smoke.sh` installs for real, starts it, uses the link like an agent, stops it and uninstalls, checking that nothing is left. CI runs it on fresh Ubuntu and macOS runners; it needs passwordless sudo and ends with an uninstall, so don't run it on a machine you use it on.
