# Vendored SDK

Files in this directory are mechanically copied from `../../sdk/dist/`.

**Do not edit them directly** — changes will be overwritten next time
`chrome-extension/scripts/vendor-sdk.sh` runs.

To refresh after changing the SDK source:

```
npm run build -w sdk
bash chrome-extension/scripts/vendor-sdk.sh
```

CI fails if the vendored files drift from `sdk/dist/`.

Last vendored from repo SHA `53cfa80`.
