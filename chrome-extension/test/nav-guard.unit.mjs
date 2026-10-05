// Unit test for the /navigate URL guard (navUrlError in lib/tools-base.js).
// Run: node chrome-extension/test/nav-guard.unit.mjs

import { navUrlError } from "../lib/tools-base.js"

const allowed = [
  "https://example.com/", "http://fcc.gov", "https://fdic.gov/x", "https://fd.io", "https://fe80.example.com",
  "https://8.8.8.8/", "http://100.63.255.255/", "http://100.128.0.1/", "http://172.32.0.1/", "http://[2606:4700::1111]/",
  "https://sub.domain.co.uk/path?q=1",
]
const blocked = [
  "file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,hi", "not a url",
  "http://localhost:3000", "http://LOCALHOST.", "http://app.localhost", "http://printer.local", "http://nas.lan",
  "http://metadata.google.internal/", "http://router.home.arpa", "http://intranet/", "http://127.0.0.1", "http://127.1",
  "http://2130706433/", "http://0x7f000001/", "http://0.0.0.0", "http://10.1.2.3", "http://172.16.0.1", "http://172.31.255.255",
  "http://192.168.1.1", "http://169.254.169.254/latest/meta-data", "http://100.64.0.1", "http://100.127.255.255", "http://224.0.0.1",
  "http://[::1]/", "http://[::]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:7f00:1]/",
  "http://[::127.0.0.1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/", "http://[febf::1]/",
]

let failed = 0
for (const u of allowed) if (navUrlError(u) !== null) { failed++; console.log(`  FAIL should allow ${u}: ${navUrlError(u)}`) }
for (const u of blocked) if (navUrlError(u) === null) { failed++; console.log(`  FAIL should block ${u}`) }
console.log(`── nav guard: ${allowed.length + blocked.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
