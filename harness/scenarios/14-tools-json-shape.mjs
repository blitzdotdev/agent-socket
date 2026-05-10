// 14-tools-json-shape — registered tools surface in tools.json with correct shape.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("14-tools-json-shape")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    appDescription: "32x32 pixel canvas the AI can paint.",
    agentsMd: "# tools.json shape test",
    tools: [
      {
        method: "POST",
        path: "/set_pixel",
        description: "Paint one pixel.",
        input_schema: {
          type: "object",
          required: ["x", "y", "color"],
          properties: {
            x: { type: "integer" },
            y: { type: "integer" },
            color: { type: "string" },
          },
        },
      },
      { path: "/clear", description: "Wipe the grid." },  // method should default to POST
    ],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "req-1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply")
  const token = mint.token

  const r = await httpGet(`/v1/t/${token}/tools.json`)
  a.equal(r.status, 200, "GET tools.json → 200")
  a.equal(r.headers.get("content-type"), "application/json; charset=utf-8", "content-type is json")

  const json = JSON.parse(r.body)
  a.equal(json.version, "1.0", "schema version 1.0")
  a.equal(json.app.id, "as_app_anon", "app.id matches register")
  a.equal(json.app.description, "32x32 pixel canvas the AI can paint.", "appDescription round-trips into app.description")
  a.ok(Array.isArray(json.tools) && json.tools.length === 2, "tools array has 2 entries", { tools: json.tools })

  const set_pixel = json.tools.find((t) => t.path === "/set_pixel")
  a.ok(set_pixel, "set_pixel tool present", { tools: json.tools })
  a.equal(set_pixel.method, "POST", "set_pixel.method is POST")
  a.equal(set_pixel.description, "Paint one pixel.", "set_pixel.description present")
  a.ok(set_pixel.input_schema?.required?.includes("x"), "input_schema preserved")

  const clear = json.tools.find((t) => t.path === "/clear")
  a.ok(clear, "clear tool present")
  a.equal(clear.method, "POST", "clear.method defaulted to POST")
  a.ok(clear.input_schema === undefined, "no input_schema when not registered")

  c.close()
}
