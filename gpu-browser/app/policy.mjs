// The checks that make up the GPU browser's boundary, kept free of I/O so
// they can be unit tested (gpu-browser/test/policy.unit.mjs). server.mjs
// applies them; nothing here talks to the network or the browser.

import net from "node:net"

// Where uploaded files are served. Requests to it are answered from memory by
// request interception and never reach the network. `.internal` is reserved
// for private use, so this can never be a real public site.
export const UPLOAD_ORIGIN = "https://uploads.gpu-browser.internal"

// Hostnames an agent may ask for: plain names or "*.example.com", lowercase,
// with a dot (so no "localhost"), no IP literals (those never match: the last
// label must start with a letter).
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
export const validHost = (h) => typeof h === "string" && h.length <= 253 && HOST_RE.test(h)

// Paths for uploads: letters, digits, . _ - /, no "." or ".." segments.
const FILE_RE = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\-/]{1,256}$/
export const validFilePath = (p) => typeof p === "string" && FILE_RE.test(p)

// Agent-defined tool paths: one segment, so they can't shadow a built-in
// (all built-ins are listed in server.mjs) or a relay-reserved path.
const TOOL_RE = /^\/[a-z0-9][a-z0-9_-]{0,63}$/
export const validToolPath = (p) => typeof p === "string" && TOOL_RE.test(p)

// Separate lists: a BlockList checks IPv4 addresses against IPv6 rules as
// IPv4-mapped, so one ::ffff:0:0/96 rule would refuse every IPv4 address.
const private4 = new net.BlockList()
const private6 = new net.BlockList()
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
]) private4.addSubnet(a, p, "ipv4")
// ::/96 also covers :: and ::1 (IPv4-compatible); 64:ff9b::/96 and
// 64:ff9b:1::/48 are NAT64, 2002::/16 6to4 and 2001::/32 Teredo: each can
// carry an IPv4 address, so all are refused.
for (const [a, p] of [
  ["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["::ffff:0:0", 96],
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2002::", 16], ["2001::", 32],
]) private6.addSubnet(a, p, "ipv6")

/** True for loopback, private, link-local (cloud metadata), CGNAT, multicast,
 *  reserved, unique-local, and IPv6 forms that embed an IPv4 address. */
export function privateAddr(ip) {
  if (net.isIPv4(ip)) return private4.check(ip, "ipv4")
  if (net.isIPv6(ip)) return private6.check(ip, "ipv6")
  return true
}

/** Does the allowlist (a Set of hosts and "*.domain" entries) cover host? */
export function hostAllowed(allowed, host) {
  const h = String(host).toLowerCase().replace(/\.$/, "")
  if (allowed.has(h)) return true
  for (let i = h.indexOf("."); i >= 0; i = h.indexOf(".", i + 1)) if (allowed.has("*" + h.slice(i))) return true
  return false
}

/** Why a proxied connection to host:port may not be made, or null. Resolution
 *  happens after this, and every resolved address goes through privateAddr. */
export function refuseTarget(allowed, host, port) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (net.isIP(h)) return "IP addresses are never reachable; use a hostname"
  if (port !== 443 && port !== 80) return "only ports 80 and 443"
  if (!hostAllowed(allowed, h)) return "not allowed yet; ask with POST /request"
  return null
}

/** Text that came from the agent and is shown to the owner (prompts, logs):
 *  no control characters, so no terminal escape sequences. Newlines are kept
 *  only where the caller asks. */
export function clean(text, { newlines = false } = {}) {
  const s = String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?")
  return newlines ? s : s.replace(/[\r\n]+/g, " | ")
}

// Chromium flags the owner may add (config), for GPU selection only. Anything
// else (--no-sandbox, --proxy-*, --remote-debugging-*, ...) could undo the
// boundary, so it is dropped. Returns { args, dropped }.
const FLAG_RE = /^--(ignore-gpu-blocklist|enable-gpu|enable-gpu-rasterization|enable-zero-copy|enable-unsafe-webgpu|use-angle=(metal|vulkan|gl|gles|swiftshader|default)|use-gl=(angle|egl|desktop)|enable-features=[A-Za-z0-9,]+|disable-features=[A-Za-z0-9,]+)$/
const FEATURES = new Set(["Vulkan", "VulkanFromANGLE", "DefaultANGLEVulkan", "SkiaGraphite", "WebGPUService", "UseSkiaRenderer", "CanvasOopRasterization"])
export function gpuFlags(list) {
  const args = []
  const dropped = []
  for (const f of Array.isArray(list) ? list.map(String) : []) {
    const m = /^--(enable|disable)-features=(.*)$/.exec(f)
    const ok = FLAG_RE.test(f) && (!m || m[2].split(",").every((x) => FEATURES.has(x)))
    ;(ok ? args : dropped).push(f)
  }
  return { args, dropped }
}
