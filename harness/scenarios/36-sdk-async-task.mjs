// 36-sdk-async-task — SDK path for async tools. Handler returns
// { status: 202, taskId }; later the app calls session.completeTask(taskId, ...)
// and the agent's poll on /_as_tasks/<taskId> resolves with the supplied body.

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP, httpGet, httpPost } from "../lib/relay.mjs"
import { connect } from "@agent-socket/sdk"

export default async function () {
  const a = new Assert("36-sdk-async-task")
  let assignedTaskId = null

  const session = await connect({
    appId: "as_app_anon",
    agentsMd: "# sdk async",
    appDescription: "SDK async-task e2e",
    tools: [
      {
        path: "/slow",
        description: "Returns 202 + taskId; completed later via completeTask.",
        handler: async () => {
          assignedTaskId = "task-" + Math.random().toString(36).slice(2, 10)
          return { status: 202, taskId: assignedTaskId }
        },
      },
    ],
    baseUrl: RELAY_HTTP,
    autoReconnect: false,
  })

  const link = await session.mintAgentToken({ label: "test" })
  const token = link.token

  // Agent fires the call; expects 202 + taskId in the body.
  const r1 = await httpPost(`/v1/t/${token}/slow`, {})
  a.equal(r1.status, 202, "first call → 202")
  a.ok(assignedTaskId !== null, "handler ran and assigned a taskId")
  a.equal(r1.json?.taskId, assignedTaskId, "agent's taskId matches handler's")

  // Poll while still pending → 202.
  const pollPending = await httpGet(`/v1/t/${token}/_as_tasks/${assignedTaskId}`)
  a.equal(pollPending.status, 202, "poll while pending → 202")

  // Complete the task via the SDK.
  session.completeTask(assignedTaskId, { status: 200, body: { ok: true, value: 99 } })

  // Tick for the relay to process.
  await new Promise((r) => setTimeout(r, 100))

  // Poll again → 200 with body.
  const pollDone = await httpGet(`/v1/t/${token}/_as_tasks/${assignedTaskId}`)
  a.equal(pollDone.status, 200, "poll after completeTask → 200")
  let doneBody
  try { doneBody = JSON.parse(pollDone.body) } catch {}
  a.equal(doneBody, { ok: true, value: 99 }, "completed body matches")

  // Argument validation: empty taskId throws.
  let threw = false
  try { session.completeTask("", { status: 200 }) } catch { threw = true }
  a.ok(threw, "completeTask('') throws")

  // Default status = 200 when result arg omitted. Fire a second /slow,
  // capture the fresh taskId, then complete with no args.
  await httpPost(`/v1/t/${token}/slow`, {})
  const freshTaskId = assignedTaskId
  session.completeTask(freshTaskId)
  await new Promise((r) => setTimeout(r, 100))
  const pollDefault = await httpGet(`/v1/t/${token}/_as_tasks/${freshTaskId}`)
  a.equal(pollDefault.status, 200, "completeTask() with no result defaults to 200")

  session.close()
}
