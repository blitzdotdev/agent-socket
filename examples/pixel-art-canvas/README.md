# Pixel Art Canvas

A 32x32 pixel grid an AI paints through tool calls. One HTML file, no build step. It imports the SDK from `../../sdk/dist`, so serve it from the repo root.

## Run

```bash
# From the repo root
npm install
npm run build -w sdk
python3 -m http.server 8000
```

Open <http://localhost:8000/examples/pixel-art-canvas/>, click **Connect with AI**, copy the link into an AI chat and ask it to paint something.

The page uses the hosted relay at `https://agentsocket.dev`. To use a local relay, run `npm run dev` (wrangler dev on port 8787) and open the page with `?relay=http://localhost:8787`.

`?harness=1` exposes `window.__harness`, which [`harness/scenarios/50-pixel-art-visual.mjs`](../../harness/scenarios/50-pixel-art-visual.mjs) uses to drive the page.

## Tools

| Tool | Body | Does |
|---|---|---|
| `POST /set_pixels` | `{ pixels: [{ x, y, color }] }` | Paint up to 1024 pixels in one call. Out-of-range entries are skipped. Returns `{ ok, painted, skipped }`. |
| `POST /fill_rect` | `{ x, y, w, h, color }` | Fill a rectangle (clipped to the grid). Returns `{ ok, painted }`. |
| `POST /set_pixel` | `{ x, y, color }` | Paint one pixel. `x`, `y` are 0-31. |
| `POST /clear` | none | Reset the grid. |
| `POST /get_grid` | none | Returns `{ size: 32, pixels }`, a 32x32 array of CSS colors. |

`color` is any CSS color. The grid is saved in `localStorage`.
