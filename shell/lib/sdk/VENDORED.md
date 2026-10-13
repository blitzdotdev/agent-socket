# Vendored SDK

Files in this directory are mechanically copied from `../../../sdk/dist/`
(the `@agent-socket/sdk` in this repo), so the shell CLI runs the
SDK it was tested with.

**Do not edit them directly** — changes will be overwritten next time
`shell/scripts/vendor-sdk.sh` runs.

To refresh after changing the SDK source:

```
npm run build      # builds the SDK and vendors it here and into the extension
```
