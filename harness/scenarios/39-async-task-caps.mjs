// 39-async-task-caps — async-task caps + taskId shape validation on the relay.
//
// Without these, a misbehaving (or hostile) app can flood task_complete frames
// to grow the DO's in-memory tasks Map until workerd OOM-kills the isolate.
// Hardened in relay-do.ts (commit following the agents.md preamble work).
//
// Covers:
//   A) invalid taskId shape on a tool_reply{202} → agent gets 502 protocol_error
//   B) MAX_TASKS_PER_SESSION cap → 101st pending task → 503 too_many_tasks
//   C) task_complete for an unknown taskId → silently dropped (poll stays "pending")
//   D) task_complete with invalid status code → silently dropped
//   E) task_complete with oversized body (> MAX_TASK_BODY_BYTES) → silently dropped
//   F) happy-path round-trip still works (sanity)

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, httpPost } from "../lib/relay.mjs"

const MAX_TASKS = 100
const MAX_BODY_BYTES = 64 * 1024

export default async function () {
  const a = new Assert("39-async-task-caps")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "# async caps test\n\nSee tools.json.",  // includes 'tools.json' so preamble doesn't trip scenario 38 patterns
    tools: [
      { method: "POST", path: "/start", description: "Returns 202+taskId per request." },
      { method: "POST", path: "/start_bad_id", description: "Returns 202 with a malformed taskId." },
    ],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "caps" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.ok)
  const token = mint.token

  // Driver: serve /start and /start_bad_id via raw WS. /start emits sequentially-
  // numbered taskIds; /start_bad_id emits a taskId with a forbidden character.
  let nextTaskN = 0
  const replied = new Set()
  ;(async () => {
    for (;;) {
      try {
        const call = await c.waitFor((m) => m.type === "tool_call" && !replied.has(m.id), 20_000)
        replied.add(call.id)
        if (call.path === "/start_bad_id") {
          c.send({ type: "tool_reply", id: call.id, status: 202, taskId: "bad/id with spaces" })
        } else {
          const id = `task-${String(++nextTaskN).padStart(4, "0")}`
          c.send({ type: "tool_reply", id: call.id, status: 202, taskId: id })
        }
      } catch { return }
    }
  })()

  // ── A) invalid taskId shape → 502 protocol_error ─────────────────────
  const rA = await httpPost(`/v1/t/${token}/start_bad_id`, {})
  a.equal(rA.status, 502, "invalid taskId → 502")
  a.equal(rA.json?.error?.code, "protocol_error", "code is protocol_error")
  // Ensure the bad taskId was NOT stored — confirm by polling /_as_tasks/<bad>.
  const pollBad = await httpGet(`/v1/t/${token}/_as_tasks/${encodeURIComponent("bad/id with spaces")}`)
  a.equal(pollBad.status, 404, "rejected taskId not stored")

  // ── F-ish) happy-path sanity (1 task) ────────────────────────────────
  const r1 = await httpPost(`/v1/t/${token}/start`, {})
  a.equal(r1.status, 202, "first /start → 202")
  a.ok(r1.json?.taskId?.startsWith("task-"), "first task got valid id")
  const firstTaskId = r1.json.taskId
  const poll1 = await httpGet(`/v1/t/${token}/_as_tasks/${firstTaskId}`)
  a.equal(poll1.status, 202, "first task initial poll → 202 pending")

  // ── C) task_complete for unknown taskId → silently dropped ──────────
  c.send({ type: "task_complete", taskId: "task-unknown-9999", status: 200, body: { fake: true } })
  await new Promise((r) => setTimeout(r, 100))
  const pollUnknown = await httpGet(`/v1/t/${token}/_as_tasks/task-unknown-9999`)
  a.equal(pollUnknown.status, 404, "unknown taskId never gets stored by task_complete")

  // ── D) invalid status code on task_complete → dropped ───────────────
  c.send({ type: "task_complete", taskId: firstTaskId, status: 999, body: { wrong: true } })
  await new Promise((r) => setTimeout(r, 100))
  const pollAfterBadStatus = await httpGet(`/v1/t/${token}/_as_tasks/${firstTaskId}`)
  a.equal(pollAfterBadStatus.status, 202, "invalid status dropped → task stays pending")

  // ── E) oversized body on task_complete → dropped ────────────────────
  // Build a body whose JSON serialization exceeds MAX_TASK_BODY_BYTES.
  const big = "x".repeat(MAX_BODY_BYTES + 100)
  c.send({ type: "task_complete", taskId: firstTaskId, status: 200, body: { blob: big } })
  await new Promise((r) => setTimeout(r, 100))
  const pollAfterBig = await httpGet(`/v1/t/${token}/_as_tasks/${firstTaskId}`)
  a.equal(pollAfterBig.status, 202, "oversized body dropped → task stays pending")

  // F) Valid completion still works.
  c.send({ type: "task_complete", taskId: firstTaskId, status: 200, body: { ok: true } })
  await new Promise((r) => setTimeout(r, 100))
  const pollDone = await httpGet(`/v1/t/${token}/_as_tasks/${firstTaskId}`)
  a.equal(pollDone.status, 200, "valid completion eventually succeeds")
  let doneBody
  try { doneBody = JSON.parse(pollDone.body) } catch {}
  a.equal(doneBody, { ok: true }, "completed body matches")

  // ── B) MAX_TASKS cap. We already have ~1 completed task. Fill to MAX
  //       with PENDING tasks (not completed) so we hit the size cap.
  //       Drive /start until we get a 503.
  let sawCap503 = false
  let calls = 0
  for (let i = 0; i < MAX_TASKS + 50 && !sawCap503; i++) {
    const r = await httpPost(`/v1/t/${token}/start`, {})
    calls++
    if (r.status === 503 && r.json?.error?.code === "too_many_tasks") {
      sawCap503 = true
      break
    }
    if (r.status !== 202) {
      a.fail(`unexpected status ${r.status} on /start call ${i+1}`)
      break
    }
  }
  a.ok(sawCap503, `cap reached: 503 too_many_tasks fired within ${calls} calls (≥ ${MAX_TASKS})`)

  c.close()
}
