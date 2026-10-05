# Minimal example

One tool (`POST /increment`) on a counter, in a browser page and in Node.

- `index.html` loads `@agent-socket/sdk` from esm.sh. Open it from any static server, click **Connect with AI** and paste the link into an AI chat.
- `node.mjs` is the same app in Node 22+:

  ```bash
  npm i @agent-socket/sdk
  node node.mjs
  ```

  Set `AGENT_SOCKET_URL` to use another relay, e.g. `AGENT_SOCKET_URL=http://localhost:8787` with `npm run dev` in this repo.

Call the tool the way an AI would:

```bash
curl -X POST <link without /agents.md>/increment -d '{"by":2}'
# {"count":2}
```
