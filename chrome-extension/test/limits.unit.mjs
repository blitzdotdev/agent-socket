// Unit tests for the session timer arithmetic and the site-lock origin check
// (lib/limits.js). Run: node --test chrome-extension/test/limits.unit.mjs

import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_SESSION_MINUTES, TIMER_CHOICES, clock, deadlineFor, lengthLabel, originAllowed, originLabel, originOf,
  sessionMinutes, shortLeft, timeLeft,
} from "../lib/limits.js"

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)

test("deadlineFor: minutes from now; 0 / missing / bad = no limit", () => {
  assert.equal(deadlineFor(60, NOW), NOW + 3_600_000)
  assert.equal(deadlineFor(15, NOW), NOW + 900_000)
  for (const m of [0, -5, null, undefined, NaN, Infinity, "60"]) assert.equal(deadlineFor(m, NOW), null, String(m))
})

test("sessionMinutes: the Settings value, else the 60 min default", () => {
  assert.equal(DEFAULT_SESSION_MINUTES, 60)
  assert.deepEqual(TIMER_CHOICES, [15, 30, 60, 120, 240, 480])
  for (const m of TIMER_CHOICES) assert.equal(sessionMinutes(m), m)
  assert.equal(sessionMinutes(0), 0)
  for (const m of [undefined, null, 7, "30", 60.5, -1]) assert.equal(sessionMinutes(m), 60, String(m))
})

test("timeLeft: never negative; null without a deadline", () => {
  assert.equal(timeLeft(null, NOW), null)
  assert.equal(timeLeft(NOW + 5000, NOW), 5000)
  assert.equal(timeLeft(NOW - 5000, NOW), 0)
})

test("shortLeft: seconds in the last minute, minutes up to an hour, then hours", () => {
  const cases = [
    [0, "0 s left"], [400, "1 s left"], [45_000, "45 s left"], [59_001, "60 s left"],
    [60_000, "1 min left"], [60_001, "2 min left"], [42 * 60_000 + 10_000, "43 min left"],
    [3_600_000, "60 min left"], [3_600_001, "1 h 1 min left"], [90 * 60_000, "1 h 30 min left"],
    [2 * 3_600_000, "2 h left"], [8 * 3_600_000, "8 h left"],
  ]
  for (const [ms, want] of cases) assert.equal(shortLeft(ms), want, String(ms))
})

test("clock: m:ss under an hour, h:mm:ss above, rounded up to the second", () => {
  const cases = [
    [0, "0:00"], [1, "0:01"], [59_999, "1:00"], [42 * 60_000 + 10_000, "42:10"], [3_599_000, "59:59"],
    [3_600_000, "1:00:00"], [3_723_000, "1:02:03"], [8 * 3_600_000, "8:00:00"],
  ]
  for (const [ms, want] of cases) assert.equal(clock(ms), want, String(ms))
})

test("lengthLabel", () => {
  assert.deepEqual([...TIMER_CHOICES, 0].map(lengthLabel), ["15 min", "30 min", "1 h", "2 h", "4 h", "8 h", "No limit"])
})

test("originOf: scheme + host + port for http(s), file:// for files, null otherwise", () => {
  const cases = [
    ["https://github.com/a/b?q=1#x", "https://github.com"],
    ["https://GitHub.com:443/", "https://github.com"],
    ["http://localhost:3000/x", "http://localhost:3000"],
    ["http://[::1]:8080/", "http://[::1]:8080"],
    ["https://user:pw@mail.google.com/", "https://mail.google.com"],
    ["file:///home/me/a.html", "file://"],
    ["chrome://newtab/", null], ["about:blank", null], ["data:text/html,hi", null],
    ["javascript:alert(1)", null], ["chrome-extension://abc/popup.html", null], ["", null], [undefined, null], ["not a url", null],
  ]
  for (const [url, want] of cases) assert.equal(originOf(url), want, String(url))
})

test("originAllowed: exact origin match, unless any site is allowed", () => {
  const lock = { origins: ["https://github.com", "http://localhost:3000"], any: false }
  for (const url of ["https://github.com/", "https://github.com/x/y?z", "http://localhost:3000/app"]) assert.equal(originAllowed(url, lock), true, url)
  for (const url of [
    "http://github.com/",              // scheme differs
    "https://gist.github.com/",        // subdomain
    "https://github.com.evil.test/",   // suffix
    "https://evilgithub.com/",
    "https://github.com:8443/",        // port differs
    "http://localhost:3001/",
    "http://localhost/",
    "https://mail.google.com/",
    "chrome://settings", "about:blank", undefined,
  ]) assert.equal(originAllowed(url, lock), false, String(url))
  assert.equal(originAllowed("https://mail.google.com/", { origins: [], any: true }), true)
  assert.equal(originAllowed("chrome://settings", { origins: [], any: true }), true)
  assert.equal(originAllowed("https://github.com/", { origins: [], any: false }), false)
})

test("originLabel", () => {
  assert.equal(originLabel("https://github.com"), "github.com")
  assert.equal(originLabel("http://localhost:3000"), "localhost:3000")
  assert.equal(originLabel("file://"), "local files")
})
