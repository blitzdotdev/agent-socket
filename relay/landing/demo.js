// "Try it on this page": connects the page to the relay as an app whose tools
// drive Fig 1 (see demo-app.js). Nothing happens until the button is pressed;
// Stop, or leaving the page, ends the session and kills the link.
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
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
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
  say(`Connected. ${log.children.length} ${log.children.length === 1 ? "call" : "calls"} from your agent so far; watch Fig 1 at the top of the page.`)
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
    say("Connected. Paste the link into your agent; its calls will show up here and move Fig 1.")
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
  connectBtn.hidden = false
  connectBtn.disabled = false
  say("Stopped. The link no longer works; connect again for a new one.")
}
stopBtn.addEventListener("click", stop)
addEventListener("pagehide", stop)
