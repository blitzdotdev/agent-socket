// Unit tests for the GPU browser's boundary checks (app/policy.mjs).
// Run: node --test gpu-browser/test/policy.unit.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { UPLOAD_ORIGIN, clean, gpuFlags, hostAllowed, privateAddr, refuseTarget, validFilePath, validHost, validToolPath } from "../app/policy.mjs"

test("privateAddr: private, local and embedded-IPv4 forms are refused; public ones pass", () => {
  const refused = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "198.51.100.7", "203.0.113.9", "192.88.99.1",
    "::1", "::", "fe80::1", "fec0::1", "feff::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:0:127.0.0.1", "::ffff:0:a00:1",
    "64:ff9b::a00:1", "64:ff9b:1::a00:1", "::a00:1", "2002:a00:1::", "2001:0:4136:e378::1", "not-an-ip",
  ]
  const allowed = ["104.20.26.136", "172.66.157.237", "172.32.0.1", "8.8.8.8", "2606:4700::6810:1a88", "2001:4860:4860::8888"]
  for (const ip of refused) assert.equal(privateAddr(ip), true, ip)
  // The bug this guards: an IPv6 ::ffff:0:0/96 rule in a shared BlockList refused every IPv4 address.
  for (const ip of allowed) assert.equal(privateAddr(ip), false, ip)
})

test("validHost: names and *.wildcards only", () => {
  for (const h of ["cdn.jsdelivr.net", "*.unpkg.com", "a.b.c.example.org", "x-y.io"]) assert.ok(validHost(h), h)
  for (const h of ["localhost", "10.0.0.1", "127.0.0.1", "[::1]", "*.com.", "CDN.example.com", "a..b.com", "*", "*.*.com", "", "ex ample.com", "-a.com", "a.com/x", null])
    assert.ok(!validHost(h), String(h))
})

test("hostAllowed: exact entries and *.domain wildcards, case and trailing dot ignored", () => {
  const allowed = new Set(["cdn.jsdelivr.net", "*.unpkg.com"])
  assert.ok(hostAllowed(allowed, "cdn.jsdelivr.net"))
  assert.ok(hostAllowed(allowed, "CDN.jsdelivr.net."))
  assert.ok(hostAllowed(allowed, "a.unpkg.com"))
  assert.ok(hostAllowed(allowed, "a.b.unpkg.com"))
  assert.ok(!hostAllowed(allowed, "unpkg.com"), "a wildcard doesn't cover the bare domain")
  assert.ok(!hostAllowed(allowed, "jsdelivr.net"))
  assert.ok(!hostAllowed(allowed, "evilunpkg.com"))
})

test("refuseTarget: IP literals, other ports and unlisted hosts are refused with a reason", () => {
  const allowed = new Set(["example.org"])
  assert.equal(refuseTarget(allowed, "example.org", 443), null)
  assert.equal(refuseTarget(allowed, "example.org", 80), null)
  assert.match(refuseTarget(allowed, "example.org", 8080), /ports/)
  assert.match(refuseTarget(allowed, "127.0.0.1", 443), /IP addresses/)
  assert.match(refuseTarget(allowed, "[::1]", 443), /IP addresses/)
  assert.match(refuseTarget(allowed, "example.com", 443), /not allowed/)
  assert.match(refuseTarget(allowed, "", 443), /not allowed/)
})

test("validFilePath and validToolPath", () => {
  for (const p of ["index.html", "assets/model.glb", "a/b/c.js", "x_y-z.1"]) assert.ok(validFilePath(p), p)
  for (const p of ["../etc/passwd", "a/../b", "./a", "a/./b", "..", "a b", "", "x".repeat(257), "a\\b"]) assert.ok(!validFilePath(p), p)
  for (const p of ["/orbit_shots", "/a", "/render-3"]) assert.ok(validToolPath(p), p)
  for (const p of ["/files/x", "/_as_tasks", "/Info", "orbit", "/agents.md", "/", "/-a"]) assert.ok(!validToolPath(p), p)
})

test("clean: no control characters or escapes reach the terminal", () => {
  assert.equal(clean("a\u001b[31mred\u0007"), "a?[31mred?")
  assert.equal(clean("one\ntwo\r\nthree"), "one | two? | three")
  assert.equal(clean("one\ntwo", { newlines: true }), "one\ntwo")
  assert.equal(clean("tab\tkept"), "tab\tkept")
  assert.equal(clean("\u009b31m"), "?31m", "C1 CSI too")
})

test("gpuFlags: GPU settings pass, anything that could undo the boundary is dropped", () => {
  const { args, dropped } = gpuFlags([
    "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan,VulkanFromANGLE", "--enable-unsafe-webgpu",
    "--no-sandbox", "--proxy-server=http://evil", "--proxy-bypass-list=*", "--remote-debugging-port=9222",
    "--enable-features=Vulkan,NetworkServiceInProcess", "--use-angle=vulkan --no-sandbox", "--disable-web-security", "--user-data-dir=/tmp/x",
  ])
  assert.deepEqual(args, ["--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan,VulkanFromANGLE", "--enable-unsafe-webgpu"])
  assert.equal(dropped.length, 8)
  assert.deepEqual(gpuFlags(undefined), { args: [], dropped: [] })
  assert.deepEqual(gpuFlags("--no-sandbox"), { args: [], dropped: [] }, "not a list: nothing")
})

test("UPLOAD_ORIGIN is under .internal, which can never be a public site", () => {
  assert.match(UPLOAD_ORIGIN, /^https:\/\/[a-z.-]+\.internal$/)
})
