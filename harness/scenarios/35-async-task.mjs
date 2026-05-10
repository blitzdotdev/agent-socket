// 35-async-task — raw WS app returns tool_reply { status:202, taskId } then
// later sends task_complete with the result. Agent polls /_as_tasks/<id>:
// first poll → 202, after task_complete → 200 with body.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("35-async-task")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "async test",
    tools: [{ method: "POST", path: "/slow", description: "returns 202 + taskId" }],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const token = mint.token

  // App auto-replies tool_call with 202 + taskId
  let capturedTaskId = null
  ;(async () => {
    const call = await c.waitFor((m) => m.type === "tool_call", 5000)
    capturedTaskId = "task-" + call.id.slice(0, 6)
    c.send({
      type: "tool_reply",
      id: call.id,
      status: 202,
      taskId: capturedTaskId,
    })
  })()

  // Agent fires the call, expects 202 with taskId.
  const r1 = await httpPost(`/v1/t/${token}/slow`, {})
  a.equal(r1.status, 202, "first call → 202")
  a.ok(r1.json && typeof r1.json.taskId === "string", "body has taskId", { body: r1.json })
  a.ok(capturedTaskId !== null, "app saw the tool_call and assigned a taskId")
  a.equal(r1.json.taskId, capturedTaskId, "agent's taskId matches app's")

  // Poll while still pending — should get 202.
  const pollPending = await httpGet(`/v1/t/${token}/_as_tasks/${capturedTaskId}`)
  a.equal(pollPending.status, 202, "poll while pending → 202")
  let pendingBody
  try { pendingBody = JSON.parse(pollPending.body) } catch {}
  a.equal(pendingBody?.completed, false, "pending body has completed:false")

  // App completes the task.
  c.send({
    type: "task_complete",
    taskId: capturedTaskId,
    status: 200,
    body: { result: "all done", count: 42 },
  })

  // Allow a tick for the relay to process.
  await new Promise((r) => setTimeout(r, 100))

  // Poll again — should be 200 with the body.
  const pollDone = await httpGet(`/v1/t/${token}/_as_tasks/${capturedTaskId}`)
  a.equal(pollDone.status, 200, "poll after completion → 200")
  let doneBody
  try { doneBody = JSON.parse(pollDone.body) } catch {}
  a.equal(doneBody, { result: "all done", count: 42 }, "completed body matches")

  // Polling an unknown taskId → 404.
  const pollUnknown = await httpGet(`/v1/t/${token}/_as_tasks/nonexistent`)
  a.equal(pollUnknown.status, 404, "unknown taskId → 404")

  c.close()
}
