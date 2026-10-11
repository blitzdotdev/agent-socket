// The app behind "Try it on this page": tools that drive the switchboard in
// Fig 1. The page passes the live figure; the session capture (capture.mjs)
// passes `modelFigure()`, the same rules without the drawing, so the transcript
// on the page shows what this exact app answers.
//
// Served as /assets/demo-app.js; no imports, plain ESM.

export const APP_ID = "agentsocket-landing"

export const AGENTS_MD = `# The Agent Socket landing page

This page draws a switchboard (Fig 1): three callers on the left are AI agents
(an agent in the cloud, a terminal, a script), the switchboard is the relay, and
two patch cords are links, one to a laptop (a browser tab) and one to an app.
Your tools drive that drawing, and the person who gave you this link is
watching it.

- GET /status: what is plugged in, whether the laptop is awake, calls answered.
- POST /send_call {"from": "cloud" | "terminal" | "script", "to": "laptop" | "app"}:
  send a call down a link and see what the relay does with it.
- POST /pull_plug {"link": "laptop" | "app"}: Stop that link. Calls to it are
  turned away.
- POST /plug_in {"link": "laptop" | "app"}: plug it back in. For a real app that
  is a new link.
- POST /close_lid and POST /open_lid: put the laptop to sleep or wake it. While it
  sleeps the relay holds its line for up to 24 hours and calls are told to retry.

A good first run: send a call to the laptop, close the lid, send another, open
the lid, pull the laptop's plug, send one more, plug it back in, then tell the
person what happened at each step.
`

const LINKS = ["laptop", "app"]
const FROM = ["cloud", "terminal", "script"]
const parse = (body) => { try { return JSON.parse(body || "{}") } catch { return null } }
const bad = (message) => ({ status: 400, body: { error: { code: "bad_input", message } } })
const MEANING = {
  ok: "answered: the relay passed the call down the link and the app replied",
  retry: "told to retry: the laptop is asleep, so the relay holds its line and answers 503 app_offline with Retry-After: 2",
  ended: "turned away: that link was pulled (Stop), so the relay answers 503 app_offline",
}

export function demoTools(figure, onCall = () => {}) {
  const tool = (method, path, description, input_schema, run) => ({
    method,
    path,
    description,
    ...(input_schema ? { input_schema } : {}),
    handler: async (ctx) => {
      const result = await run(ctx)
      onCall({ path, body: ctx.body, result })
      return result
    },
  })
  const linkArg = (ctx) => {
    const args = parse(ctx.body)
    if (!args || !LINKS.includes(args.link)) return null
    return args.link
  }
  const LINK_SCHEMA = { type: "object", required: ["link"], properties: { link: { enum: LINKS } } }
  return [
    tool("GET", "/status", "What is plugged in, whether the laptop is awake, and how many calls were answered.", null, () => figure.state()),
    tool("POST", "/send_call", "Send one call from a caller down a link. Returns what the relay did with it.", {
      type: "object", required: ["from", "to"], properties: { from: { enum: FROM }, to: { enum: LINKS } },
    }, async (ctx) => {
      const args = parse(ctx.body)
      if (!args || !FROM.includes(args.from) || !LINKS.includes(args.to)) return bad(`expected {"from": ${FROM.map((f) => `"${f}"`).join("|")}, "to": "laptop"|"app"}`)
      const verdict = await figure.send(args.from, args.to)
      return { from: args.from, to: args.to, result: MEANING[verdict] }
    }),
    tool("POST", "/pull_plug", "Stop a link: pull its plug. Calls to it are turned away until it is plugged back in.", LINK_SCHEMA, (ctx) => {
      const link = linkArg(ctx)
      if (!link) return bad(`expected {"link": "laptop"|"app"}`)
      figure.setPlug(link, true)
      return { link, now: "pulled" }
    }),
    tool("POST", "/plug_in", "Plug a link back in. For a real app this is a new link.", LINK_SCHEMA, (ctx) => {
      const link = linkArg(ctx)
      if (!link) return bad(`expected {"link": "laptop"|"app"}`)
      figure.setPlug(link, false)
      return { link, now: "plugged in" }
    }),
    tool("POST", "/close_lid", "Put the laptop to sleep. The relay holds its line.", null, () => {
      figure.setLid(false)
      return { laptop: "asleep", note: "the relay holds the line for up to 24 h; calls to the laptop are told to retry" }
    }),
    tool("POST", "/open_lid", "Wake the laptop. The same link carries on.", null, () => {
      figure.setLid(true)
      return { laptop: "awake", note: "same link, nothing to paste again" }
    }),
  ]
}

// The figure's rules without the drawing (for Node and tests).
export function modelFigure() {
  const m = { plugged: { laptop: true, app: true }, awake: true, answered: 0 }
  return {
    takeOver() {},
    release() {},
    state: () => ({
      laptop_link: m.plugged.laptop ? "plugged in" : "pulled",
      app_link: m.plugged.app ? "plugged in" : "pulled",
      laptop: m.awake ? "awake" : "asleep (the switchboard holds its line)",
      calls_answered: m.answered,
    }),
    setPlug(link, pulled) { m.plugged[link] = !pulled },
    setLid(open) { m.awake = open },
    async send(from, to) {
      const verdict = !m.plugged[to] ? "ended" : to === "laptop" && !m.awake ? "retry" : "ok"
      if (verdict === "ok") m.answered++
      return verdict
    },
  }
}
