// Builds the landing page into relay/public: index.html, assets/hero.js,
// assets/demo.js, assets/demo-app.js and sdk/ (the vendored SDK, for the live
// demo). Run after changing anything in relay/landing:
//
//   npm run landing
//
// The figures are built here with the anatomy kit (kit/, MIT); the page ships
// static SVG and small scripts, no build step at runtime.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as k from "./kit/iso-kit.mjs"
import { buildHero } from "./figures/hero.mjs"
import { FIGURE_CSS } from "./figures/style.mjs"
import { howSvg, HOW_CSS } from "./figures/how.mjs"
import { popupHtml, POPUP_CSS } from "./figures/popup.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(HERE, "..", "public")
const SDK = join(HERE, "..", "..", "chrome-extension", "lib", "sdk")
const read = (f) => readFileSync(join(HERE, f), "utf8")
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// ── Fig 1 ──────────────────────────────────────────────────────────────
const hero = buildHero()
const { svg: heroSvg, ...heroData } = hero
const heroPlate = k.plateHtml({
  fig: "Fig 1",
  title: "One link, any agent",
  hint: "Click a plug or the laptop",
  readout: "both links live · 0 calls answered",
  keys: [
    { mark: "lit", label: "A link: a patch cord in its socket" },
    { mark: "raised", label: "Callers: an agent in the cloud, a terminal, a script" },
  ],
  caption: "The relay as a switchboard. Every caller on the left reaches your tab or your app through one link, the patch cord. Close the laptop and the switchboard holds the line; open it and the same link carries on. Pull the plug and that link is dead.",
  body: `<div class="iso-stage" data-hero tabindex="0" role="group" aria-label="Fig 1, interactive. Keys: P pulls or replaces the laptop's plug, A the app's, L closes or opens the laptop.">${heroSvg}</div><p class="sr" data-hero-status aria-live="polite"></p>`,
})

// ── Fig 2 ──────────────────────────────────────────────────────────────
const howPlate = k.plateHtml({
  fig: "Fig 2",
  title: "One call",
  readout: "",
  caption: "Your side opens the line; the agent only makes web requests. The relay answers the agent's reading itself and passes every action down the open connection.",
  body: `<div class="fhow-scroll">${howSvg()}</div>`,
})

// ── live demo ──────────────────────────────────────────────────────────
const demoHtml = `<div class="demo" data-demo>
      <div class="row">
        <button class="btn" type="button" data-connect>Connect this page</button>
        <span class="link" data-link hidden></span>
        <button class="btn quiet" type="button" data-copy hidden>Copy</button>
        <button class="btn quiet" type="button" data-stop hidden>Stop</button>
      </div>
      <div class="prompt" data-prompt hidden>Paste the link into your agent with something like:<q data-prompt-text></q></div>
      <div class="state" data-state>Not connected. Pressing the button opens a session on the relay at agentsocket.dev for this page only.</div>
      <ol data-log aria-label="Calls from your agent"></ol>
    </div>`

// ── a real session ────────────────────────────────────────────────────
function transcriptHtml() {
  const t = JSON.parse(read("transcript.json"))
  const keep = (s) => !(s.kind === "call" && (s.path === "/status" && s.status === 200))
  const describe = (s) => {
    if (s.path === "/agents.md") {
      const first = (s.text ?? "").split("\n").find((l) => l.startsWith("# ")) ?? ""
      return `The relay's own notes on how to call tools, then the page's: <q>${esc(first.replace(/^# /, ""))}</q>, with its tools and a suggested first run.`
    }
    if (s.path === "/tools.json") return `${s.json.tools.length} tools: ${s.json.tools.map((x) => `<span class="chip">${esc(x.method)} ${esc(x.path)}</span>`).join(" ")}`
    if (s.json?.error) return `<b>${esc(s.json.error.code)}</b>: ${esc(s.json.error.message)}`
    return esc(JSON.stringify(s.json).replace(/,"/g, ', "').replace(/":/g, '": '))
  }
  const rows = t.steps.filter(keep).map((s) => {
    if (s.kind === "note") return `<div class="turn event"><div class="who">${s.text.startsWith("The person") ? "You" : "The app"}</div><div class="say">${esc(s.text.replace(/: https?:\/\/\S+/, ""))}</div></div>`
    const body = s.body ? ` <i>${esc(JSON.stringify(s.body).replace(/,"/g, ', "').replace(/":/g, '": '))}</i>` : ""
    const req = `<div class="turn agent"><div class="who">Agent</div><div class="say"><span class="req">${s.method} <i>…</i>${esc(s.path)}${body}</span></div></div>`
    const st = `<span class="st${s.status >= 400 ? " warn" : ""}">${s.status}${s.retryAfter ? ` · Retry-After ${esc(s.retryAfter)}` : ""}</span>`
    const res = `<div class="turn relay"><div class="who">${s.status >= 500 && s.json?.error ? "Relay" : s.path.endsWith(".md") || s.path.endsWith(".json") ? "Relay" : "Page"}</div><div class="say">${st}<span class="body">${describe(s)}</span></div></div>`
    return req + res
  })
  const when = new Date(t.recorded).toISOString().slice(0, 10)
  return `<p>Recorded on ${when} against the live relay: the demo app from section 05 running in Node, and a script in the agent's seat using nothing but web requests. Halfway through, the app's connection is cut without a goodbye, the way a sleeping laptop looks to the relay. Only the routine status checks are left out, and the link's secret part is hidden; nothing else is edited. The 200 replies are the demo app's own: it simulates Fig 1, so its words describe the switchboard.</p>
    <div class="talk">${rows.join("\n")}</div>
    <p class="sidenote">The script that made this is <a href="https://github.com/blitzdotdev/agent-socket/blob/master/relay/landing/capture.mjs">relay/landing/capture.mjs</a>.</p>`
}

// ── watch it ───────────────────────────────────────────────────────────
function watchHtml() {
  if (existsSync(join(PUBLIC, "media", "demo.mp4"))) {
    return `<p>A script with this page's link, in the agent's seat, drives Fig 1 through the live relay: answered calls, the laptop asleep and the line held, the plug pulled and calls turned away, then plugged back in. Recorded in a headless browser with no cuts, shown at twice the speed. The script is <a href="https://github.com/blitzdotdev/agent-socket/blob/master/relay/landing/record.mjs">relay/landing/record.mjs</a>.</p>
    <figure class="video wide"><video src="/media/demo.mp4" poster="/media/demo.jpg" muted loop playsinline controls preload="none" width="1000" height="650" style="width:100%;height:auto;border-radius:12px;box-shadow:0 0 0 1px var(--rule)"></video></figure>`
  }
  // No recording yet: leave the section out rather than show a fake one.
  return ""
}

// ── assemble ───────────────────────────────────────────────────────────
let html = read("page.html")
const css = `<style>${k.ISO_CSS}${FIGURE_CSS}${HOW_CSS}${POPUP_CSS}</style>`
const watch = watchHtml()
html = html
  .replace("<!--FIGURE_CSS-->", css)
  .replace("<!--HERO-->", heroPlate)
  .replace("<!--HOW-->", howPlate)
  .replace("<!--POPUP-->", popupHtml())
  .replace("<!--DEMO-->", demoHtml)
  .replace("<!--TRANSCRIPT-->", transcriptHtml())
  .replace("<!--WATCH-->", watch)
  .replace("<!--SCRIPTS-->", `<script type="module" src="/assets/hero.js"></script>\n<script type="module" src="/assets/demo.js"></script>`)
if (!watch) html = html.replace(/<section id="watch"[\s\S]*?<\/section>\s*/, "").replace(/\s*<a href="#watch">Watch it<\/a>/, "")
  .replace(/<span class="n">09<\/span>/, '<span class="n">08</span>').replace(/<span class="n">10<\/span>/, '<span class="n">09</span>')

mkdirSync(join(PUBLIC, "assets"), { recursive: true })
mkdirSync(join(PUBLIC, "sdk"), { recursive: true })
writeFileSync(join(PUBLIC, "index.html"), html)
writeFileSync(join(PUBLIC, "assets", "hero.js"), `// Built by relay/landing/build.mjs from figures/hero.mjs and figures/hero.live.js.\nconst HERO = ${JSON.stringify(heroData)};\n${read("figures/hero.live.js")}`)
writeFileSync(join(PUBLIC, "assets", "demo-app.js"), read("demo-app.mjs"))
writeFileSync(join(PUBLIC, "assets", "demo.js"), read("demo.js"))
for (const f of readdirSync(SDK)) if (f.endsWith(".js")) copyFileSync(join(SDK, f), join(PUBLIC, "sdk", f))
console.log(`wrote relay/public: index.html ${(html.length / 1024).toFixed(0)} KB, assets/hero.js ${(JSON.stringify(heroData).length / 1024).toFixed(0)} KB data`)
