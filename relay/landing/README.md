# Landing page

Source for agentsocket.dev's front page. `npm run landing` (from the repo root)
builds it into `relay/public/`: `index.html`, `assets/hero.js`, `assets/demo.js`,
`assets/demo-app.js` and `sdk/` (a copy of `chrome-extension/lib/sdk`, for the
live demo). Commit the built files; the relay serves them as static assets.

| File | What it is |
|---|---|
| `page.html` | The page, with `<!--…-->` slots the build fills. |
| `figures/hero.mjs` | Fig 1, the switchboard: geometry built with the anatomy kit, plus the paths and lid frames its live script needs. |
| `figures/hero.live.js` | Fig 1's behaviour (the tour, beads, plugs, lid) and `window.heroFigure`, which the demo drives. |
| `figures/how.mjs`, `figures/popup.mjs` | Fig 2 (one call across three lanes) and Fig 3 (the extension popup). |
| `demo-app.mjs` | The app behind "Try it on this page": its notes and tools. The same file runs in Node for `capture.mjs`. |
| `demo.js` | The demo's buttons and call log. |
| `capture.mjs` | Records `transcript.json` ("A real session") against the live relay. Run it again after changing the demo app. |
| `record.mjs` | Records `relay/public/media/demo.mp4` ("Watch it"). Needs ffmpeg and a local preview of the page. |
| `kit/` | The [anatomy](https://github.com/wheresryan22/anatomy) kit (MIT, see `kit/LICENSE`), used at build time only. |

Fonts in `relay/public/fonts` are subsets of Inter and Newsreader Italic under
the SIL Open Font License (`relay/public/fonts/LICENSE.txt`).

Preview: `cd relay && npx wrangler dev --env="" --ip 0.0.0.0`, then open the
printed URL. The live demo connects to the relay the page is served from;
`?relay=https://agentsocket.dev` points it at the hosted one.
