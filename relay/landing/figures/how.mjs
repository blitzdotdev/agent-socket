// Fig 2: one call, as a sequence across three lanes (the agent, the relay,
// your tab or app). Flat drawing in the same inks as the figures: thin rules,
// one accent for the link, words only as lane names and short step labels.

export function howSvg() {
  const W = 760, H = 414
  const lanes = [{ x: 130, name: "The agent", sub: "Claude Code, Codex, a script…" }, { x: 380, name: "The relay", sub: "agentsocket.dev, or your own" }, { x: 630, name: "Your tab or app", sub: "the extension, or the SDK" }]
  const X = lanes.map((l) => l.x)
  const top = 74, bottom = 404
  const rows = [104, 198, 270, 340]
  const out = []
  const t = (x, y, s, cls = "fl", anchor = "middle") => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${s}</text>`
  const arrow = (x1, x2, y, { cls = "fa", dash = "" } = {}) => {
    const dir = Math.sign(x2 - x1)
    const tip = x2 - dir * 1.5
    return `<path class="${cls}" ${dash ? `stroke-dasharray="${dash}"` : ""} d="M${x1 + dir * 6} ${y}H${tip}"/><path class="${cls}-head" d="M${tip} ${y}l${-dir * 6} -3.2v6.4z"/>`
  }
  // the held line: shaded between the relay and the tab while the session lasts
  out.push(`<rect class="fh" x="${X[1]}" y="${rows[0] + 22}" width="${X[2] - X[1]}" height="${bottom - rows[0] - 44}" rx="3"/>`)
  out.push(t((X[1] + X[2]) / 2, bottom - 6, "one connection, held open while the session lasts", "fl fl-accent"))
  lanes.forEach((l) => {
    out.push(`<rect class="fbox" x="${l.x - 92}" y="18" width="184" height="40" rx="8"/>`)
    out.push(t(l.x, 35, l.name, "fl fl-strong"), t(l.x, 50, l.sub, "fl fl-muted"))
    out.push(`<path class="flane" d="M${l.x} ${top}V${bottom - 18}"/>`)
  })
  // 1. connects, gets a link
  out.push(`<circle class="fnum" cx="34" cy="${rows[0] + 8}" r="9"/>`, t(34, rows[0] + 12, "1", "fl fl-num"))
  out.push(arrow(X[2], X[1], rows[0]), t((X[1] + X[2]) / 2, rows[0] - 7, "connects, lists its actions"))
  out.push(arrow(X[1], X[2], rows[0] + 22, { cls: "fa fa-accent", dash: "4 3" }), t((X[1] + X[2]) / 2, rows[0] + 36, "a link for this session", "fl fl-accent"))
  // 2. the person pastes it
  out.push(`<circle class="fnum" cx="34" cy="${rows[1] + 2}" r="9"/>`, t(34, rows[1] + 6, "2", "fl fl-num"))
  out.push(`<path class="fa" stroke-dasharray="1.5 3.5" d="M${X[2] - 6} ${rows[1]}C${X[2] - 120} ${rows[1] - 22} ${X[0] + 120} ${rows[1] - 22} ${X[0] + 6} ${rows[1]}"/><path class="fa-head" d="M${X[0] + 4.5} ${rows[1]}l6.4 -1.2l-2.8 5.6z"/>`)
  out.push(t((X[0] + X[2]) / 2, rows[1] - 24, "you paste the link into the agent's chat"))
  // 3. reads agents.md and tools.json, answered by the relay
  out.push(`<circle class="fnum" cx="34" cy="${rows[2] + 6}" r="9"/>`, t(34, rows[2] + 10, "3", "fl fl-num"))
  out.push(arrow(X[0], X[1], rows[2] - 4), t((X[0] + X[1]) / 2, rows[2] - 11, "GET agents.md, tools.json"))
  out.push(arrow(X[1], X[0], rows[2] + 14, { dash: "4 3" }), t((X[0] + X[1]) / 2, rows[2] + 28, "answered by the relay itself", "fl fl-muted"))
  // 4. calls an action, forwarded, done, answered
  out.push(`<circle class="fnum" cx="34" cy="${rows[3] + 6}" r="9"/>`, t(34, rows[3] + 10, "4", "fl fl-num"))
  out.push(arrow(X[0], X[1], rows[3] - 4), t((X[0] + X[1]) / 2, rows[3] - 11, "POST …/click {\"selector\": …}"))
  out.push(arrow(X[1], X[2], rows[3] - 4), t((X[1] + X[2]) / 2, rows[3] - 11, "forwarded down the open line"))
  out.push(arrow(X[2], X[1], rows[3] + 12, { dash: "4 3" }), arrow(X[1], X[0], rows[3] + 12, { dash: "4 3" }))
  out.push(t((X[0] + X[1]) / 2, rows[3] + 26, "{\"clicked\": true}", "fl fl-muted"), t((X[1] + X[2]) / 2, rows[3] + 26, "done in your tab, the reply", "fl fl-muted"))
  return `<svg class="iso-svg fhow" viewBox="0 0 ${W} ${H}" role="img" aria-label="A sequence across three lanes: the agent, the relay and your tab or app. 1: your tab or app connects to the relay and lists its actions; the relay gives it a link. 2: you paste the link into the agent's chat. 3: the agent fetches agents.md and tools.json, which the relay answers itself. 4: the agent calls an action; the relay forwards it down the open connection, your tab does it, and the reply comes back the same way.">${out.join("")}</svg>`
}

export const HOW_CSS = `
.fhow-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
@media (max-width:700px){.fhow-scroll .fhow{min-width:640px}}
.fhow .fl{font:500 11.5px var(--sans);fill:var(--text,#45454a)}
.fhow .fl-strong{font-weight:600;font-size:12.5px;fill:var(--ink,#1d1d20)}
.fhow .fl-muted{font-weight:400;fill:var(--muted,#8b8b90)}
.fhow .fl-accent{fill:var(--as-accent);font-weight:500}
.fhow .fl-num{font-size:10.5px;font-weight:600;fill:var(--muted,#8b8b90)}
.fhow .fbox{fill:#fff;stroke:#d6d6d3;stroke-width:1}
.fhow .flane{stroke:#dcdcd9;stroke-width:1;stroke-dasharray:2 4;fill:none}
.fhow .fh{fill:var(--as-accent);opacity:.05}
.fhow .fnum{fill:none;stroke:#d0d0cd;stroke-width:1}
.fhow .fa{stroke:var(--anatomy-hi);stroke-width:1.1;fill:none}
.fhow .fa-head{fill:var(--anatomy-hi)}
.fhow .fa-accent{stroke:var(--as-accent)}
.fhow .fa-accent-head{fill:var(--as-accent)}
`
