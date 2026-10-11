// Unit tests for who may send which message to the background worker
// (lib/messages.js). Run: node --test chrome-extension/test/messages.unit.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { MESSAGE_SENDERS, senderAllowed, senderKind } from "../lib/messages.js"

const ID = "abcdefghijklmnopabcdefghijklmnop"
const EXT = `chrome-extension://${ID}/`
const popup = { id: ID, url: `${EXT}popup.html` }
const popupAsTab = { id: ID, url: `${EXT}popup.html`, tab: { id: 7 }, frameId: 0 }
const pill = { id: ID, url: "https://github.com/x", tab: { id: 3 }, frameId: 0 }
const pillInFrame = { id: ID, url: "https://ads.example/frame", tab: { id: 3 }, frameId: 5 }
const otherExt = { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", url: "chrome-extension://zzzz/x.html" }

test("senderKind: our pages (popup or as a tab), the pill in a top frame, nothing else", () => {
  assert.equal(senderKind(popup, ID, EXT), "popup")
  assert.equal(senderKind(popupAsTab, ID, EXT), "popup")
  assert.equal(senderKind(pill, ID, EXT), "pill")
  assert.equal(senderKind(pillInFrame, ID, EXT), null)
  assert.equal(senderKind(otherExt, ID, EXT), null)
  assert.equal(senderKind(undefined, ID, EXT), null)
  // A content script on a page whose address merely contains our origin.
  assert.equal(senderKind({ id: ID, url: `https://evil.example/?${EXT}`, tab: { id: 1 }, frameId: 0 }, ID, EXT), "pill")
})

test("the pill can't drive popup-only messages", () => {
  for (const type of ["connect", "snapshot", "check_user_scripts", "keep_profile", "discard_profile", "delete_profile",
    "set_relay_base", "set_registry_base", "list_profiles", "set_timer", "remove_origin", "set_any_origin", "disconnect_all"]) {
    assert.equal(senderAllowed(type, "pill"), false, type)
    assert.equal(senderAllowed(type, "popup"), true, type)
  }
})

test("pill-only and shared messages", () => {
  for (const type of ["pill_state", "pill_link", "open_popup"]) {
    assert.equal(senderAllowed(type, "pill"), true, type)
    assert.equal(senderAllowed(type, "popup"), false, type)
  }
  for (const type of ["disconnect", "allow_origin", "ack_link"]) {
    assert.equal(senderAllowed(type, "pill"), true, type)
    assert.equal(senderAllowed(type, "popup"), true, type)
  }
})

test("unknown types and unknown senders are refused", () => {
  assert.equal(senderAllowed("nope", "popup"), false)
  assert.equal(senderAllowed("snapshot", null), false)
  assert.ok(Object.values(MESSAGE_SENDERS).every((v) => ["popup", "pill", "either"].includes(v)))
})
