// 43-bad-tool-reply — a tool_reply / task_complete the relay can't turn into
// an HTTP response (status outside 200-599, header value with a newline)
// gets the agent a prompt 502, and the app's socket survives.
// Regression for: Response construction threw after the pending entry was
// dropped, so the agent's request hung forever and the app WS died.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, RELAY_HTTP } from "../lib/relay.mjs"

async function post(path) {
  try {
    const r = await fetch(`${RELAY_HTTP}${path}`, { method: "POST", body: "{}", signal: AbortSignal.timeout(5000) })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, text, json }
  } catch (e) {
    return { status: 0, error: e.name }
  }
}

export default async function () {
  const a = new Assert("43-bad-tool-reply")
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# test", tools: [{ path: "/t", description: "t" }] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")

  // Each call is answered with the next reply in this queue.
  const replies = []
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString())
    if (m.type === "tool_call") c.send({ type: "tool_reply", id: m.id, ...replies.shift() })
  })

  const bad = [
    { name: "status 0", reply: { status: 0, body: {} } },
    { name: "status 101", reply: { status: 101, body: {} } },
    { name: "status 600", reply: { status: 600, body: {} } },
    { name: "status '200'", reply: { status: "200", body: {} } },
    { name: "newline in content-type", reply: { status: 200, body: "x", headers: { "content-type": "text/plain\r\nx-evil: 1" } } },
  ]
  for (const b of bad) {
    replies.push(b.reply)
    const r = await post(`/v1/t/${token}/t`)
    a.equal(r.status, 502, `${b.name}: agent gets 502`)
    a.equal(r.json?.error?.code, "protocol_error", `${b.name}: clean relay error body`)
  }

  replies.push({ status: 200, body: { ok: true } })
  const good = await post(`/v1/t/${token}/t`)
  a.equal(good.status, 200, "app socket still serves calls after bad replies")

  // task_complete with a 1xx status is dropped, so the task stays pending.
  replies.push({ status: 202, taskId: "t1" })
  const started = await post(`/v1/t/${token}/t`)
  a.equal(started.status, 202, "async task started")
  c.send({ type: "task_complete", taskId: "t1", status: 150, body: {} })
  await new Promise((r) => setTimeout(r, 200))
  const poll = await fetch(`${RELAY_HTTP}/v1/t/${token}/_as_tasks/t1`)
  const pollText = await poll.text()
  a.equal(poll.status, 202, "1xx task_complete ignored; task still pending")
  a.ok(!/at .*\(/.test(pollText), "no stack trace in poll response", { pollText })

  c.close()
}
