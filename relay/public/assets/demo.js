// "Try it on this page": connects the page to the relay as an app whose tools
// drive Fig 1 (see demo-app.js). The controls sit on Fig 1's bottom edge, so
// the figure moves in view of them. Nothing happens until a button is
// pressed; Stop, or leaving the page, ends the session and kills the link.
import { connect } from "/sdk/index.js"
import { APP_ID, AGENTS_MD, demoTools } from "/assets/demo-app.js"

const root = document.querySelector("[data-demo]")
const $ = (name) => root.querySelector(`[data-${name}]`)
const connectBtn = $("connect"), linkEl = $("link"), copyBtn = $("copy"), stopBtn = $("stop")
const promptBox = $("prompt"), promptText = $("prompt-text"), stateEl = $("state"), log = $("log")
const relay = new URLSearchParams(location.search).get("relay") ?? location.origin
let session = null

const say = (text) => { stateEl.textContent = text }
function logCall({ path, body, result }) {
  const li = document.createElement("li")
  const time = document.createElement("time")
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  const what = document.createElement("span")
  let args = ""
  try { const a = JSON.parse(body || "{}"); args = Object.values(a).join(" → ") } catch {}
  what.textContent = path.slice(1) + (args ? ` ${args}` : "")
  const r = document.createElement("span")
  r.className = "r"
  const res = result?.body ?? result
  r.textContent = result?.status >= 400 ? `${result.status}` : (res?.result ?? res?.now ?? res?.laptop ?? "ok").split(":")[0]
  li.append(time, what, r)
  log.prepend(li)
  say(`Connected. ${log.children.length} ${log.children.length === 1 ? "call" : "calls"} from your agent so far.`)
}

connectBtn.addEventListener("click", async () => {
  const figure = window.heroFigure
  if (!figure) return say("The figure didn't load, so there is nothing to drive.")
  connectBtn.disabled = true
  say("Connecting…")
  try {
    session = await connect({ baseUrl: relay, appId: APP_ID, agentsMd: AGENTS_MD, tools: demoTools(figure, logCall) })
    const link = await session.mintAgentToken({ label: "landing page" })
    figure.takeOver()
    linkEl.textContent = link.url
    promptText.textContent = `Here's a link to a web page I have open: ${link.url}. Work the switchboard on it: send a call to the laptop, close the lid, send another, open it, pull the laptop's plug, send one more, plug it back in, and tell me what happened at each step.`
    for (const el of [linkEl, copyBtn, stopBtn, promptBox]) el.hidden = false
    connectBtn.hidden = true
    root.dataset.on = ""
    say("Connected. Copy the link into your agent: its calls show up here and move the switchboard.")
  } catch (e) {
    connectBtn.disabled = false
    say(`Couldn't connect: ${e?.message ?? e}`)
  }
})
copyBtn.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(promptText.textContent); copyBtn.textContent = "Copied" } catch { copyBtn.textContent = "Select and copy" }
  setTimeout(() => (copyBtn.textContent = "Copy"), 1600)
})
function stop() {
  if (!session) return
  session.close()
  session = null
  window.heroFigure?.release()
  for (const el of [linkEl, copyBtn, stopBtn, promptBox]) el.hidden = true
  delete root.dataset.on
  connectBtn.hidden = false
  connectBtn.disabled = false
  say("Stopped. The link no longer works; connect again for a new one.")
}
stopBtn.addEventListener("click", stop)

// "Try it on this page" in the header: bring Fig 1 and its controls into view
// together, centred when they fit, and connect.
const unit = root.closest(".iso-figure")
for (const a of document.querySelectorAll("[data-try]")) a.addEventListener("click", (e) => {
  e.preventDefault()
  const plate = unit.querySelector(".iso-plate").getBoundingClientRect()
  const strip = root.getBoundingClientRect()
  const height = strip.bottom - plate.top
  const top = scrollY + plate.top - Math.max(12, (innerHeight - height) / 2)
  scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  if (!session && !connectBtn.disabled) connectBtn.click()
})
addEventListener("pagehide", stop)
