# Pixel Art Canvas — agent-socket demo

A 32×32 pixel grid the AI can paint by calling `/set_pixel`, `/clear`, and `/get_grid`. The reveal-over-time effect is great on Twitter video.

## Run

```bash
# Terminal 1 — start the relay
cd ../../relay
npm run dev          # wrangler dev on http://localhost:8787

# Terminal 2 — serve the SPA on any static port
cd ../examples/pixel-art-canvas
python3 -m http.server 5173
# or:  npx serve -p 5173
```

Open `http://localhost:5173/` in your browser. Click "Connect with AI", copy the URL, paste into Claude / ChatGPT / Gemini, and ask the AI to paint something.

## Configuration

- `?relay=https://your-relay.example` — point at a different relay (default `http://localhost:8787`)
- `?harness=1` — exposes a `window.__harness` test hook (used by the harness's visual scenario)

## Tools exposed to the AI

| Path | Body | What it does |
|---|---|---|
| `POST /set_pixel` | `{ x, y, color }` | Paint one cell. `x`, `y` are 0..31; `color` is any CSS color. |
| `POST /clear` | (empty) | Wipe the grid. |
| `POST /get_grid` | (empty) | Returns `{ size: 32, pixels: [[colors]] }` so the AI can read state before iterating. |
