# gpu-browser/scripts

`vendor-sdk.sh` copies the built SDK (`sdk/dist`) into `../app/lib/sdk/`. `npm run build` at the repo root runs it; CI fails if the copy is stale.
