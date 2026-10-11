// Dev only: writes /tmp/landing-v2/hero.html, the hero figure alone on a page.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs"
import * as k from "./kit/iso-kit.mjs"
import { buildHero } from "./figures/hero.mjs"
import { FIGURE_CSS } from "./figures/style.mjs"

const hero = buildHero()
mkdirSync("/tmp/landing-v2", { recursive: true })
const { svg, ...data } = hero
const live = `const HERO = ${JSON.stringify(data)};\n` + readFileSync(new URL("./figures/hero.live.js", import.meta.url), "utf8")
const body = k.plateHtml({ fig: "Fig 1", title: "Switchboard", hint: "Click the plug or the laptop", readout: "both links live", body: `<div class="iso-stage" data-hero tabindex="0">${svg}</div><p data-hero-status class="sr" aria-live="polite"></p>` })
writeFileSync("/tmp/landing-v2/hero.html", k.pageHtml({ title: "hero", theme: "light", body: `<style>${FIGURE_CSS}.sr{position:absolute;clip:rect(0 0 0 0)}</style>${body}`, width: 900, script: live }))
console.log("wrote /tmp/landing-v2/hero.html", (JSON.stringify(data).length / 1024).toFixed(0) + " KB data,", (svg.length / 1024).toFixed(0) + " KB svg")
