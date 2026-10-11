// Records "A real session" for the landing page: this page's demo app
// (demo-app.mjs, run in Node) connects to the live relay, and a scripted agent
// uses the link with plain fetch. Every request and response below is real.
// Halfway through, the app's socket is dropped without a clean close (what a
// sleeping laptop looks like to the relay), then the app resumes with its
// secret; at the end the app stops. Writes transcript.json next to this file.
//
//   node relay/landing/capture.mjs [relay base, default https://agentsocket.dev]

import { writeFileSync } from "node:fs"
import { connect } from "../../chrome-extension/lib/sdk/index.js"
import { APP_ID, AGENTS_MD, demoTools, modelFigure } from "./demo-app.mjs"

const BASE = process.argv[2] ?? "https://agentsocket.dev"
const figure = modelFigure()
const steps = []
const note = (text) => steps.push({ kind: "note", text })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const open = (resume) => connect({ baseUrl: BASE, appId: APP_ID, agentsMd: AGENTS_MD, tools: demoTools(figure), autoReconnect: false, ...(resume ? { resume } : {}) })

let session = await open()
const link = await session.mintAgentToken({ label: "transcript" })
const base = link.url.replace(/\/agents\.md$/, "")
const shown = base.replace(/(as_[A-Z0-9]{8})_[A-Za-z0-9_-]+/, "$1_…")
note(`The app connected and made a link: ${shown}/agents.md`)

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  steps.push({ kind: "call", method, path, body: body ?? null, status: res.status, retryAfter: res.headers.get("retry-after"), json, text: json ? null : text })
  return { status: res.status, json, text }
}

await call("GET", "/agents.md")
await call("GET", "/tools.json")
await call("POST", "/send_call", { from: "cloud", to: "laptop" })
await call("POST", "/pull_plug", { link: "app" })
await call("POST", "/send_call", { from: "script", to: "app" })
await call("POST", "/plug_in", { link: "app" })

// The laptop really goes away: drop the socket without a clean close.
const held = { sessionId: session.sessionId, secret: session.resumeSecret }
session.ws.close(4000, "gone")
await sleep(1500)
note("The app's connection dropped without a clean close, like a laptop going to sleep. The relay holds the session.")
await call("POST", "/send_call", { from: "terminal", to: "app" })

session = await open(held)
note(`The app came back and resumed with its secret: same session (${session.sessionId === held.sessionId ? "same id" : "NEW id"}), same link.`)
await call("POST", "/send_call", { from: "terminal", to: "app" })
await call("GET", "/status")

session.close()
await sleep(800)
note("The person pressed Stop: the app closed the session.")
await call("GET", "/status")

const out = { base: shown, relay: BASE, recorded: new Date().toISOString(), steps }
writeFileSync(new URL("./transcript.json", import.meta.url), JSON.stringify(out, null, 2) + "\n")
console.log(steps.map((s) => (s.kind === "note" ? `-- ${s.text}` : `${s.method} ${s.path} → ${s.status}${s.retryAfter ? ` (Retry-After ${s.retryAfter})` : ""}`)).join("\n"))
process.exit(0)
