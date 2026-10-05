// Load-unpacked copy of the extension for the puppeteer tests. Site access is
// an optional permission requested from the popup, and puppeteer can't click
// Chrome's permission prompt, so the copy grants <all_urls> at install instead.
// Everything else is the real extension.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function testExtensionDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-ext-src-"))
  fs.cpSync(EXT_DIR, dir, { recursive: true, filter: (src) => !/[/\\](test|scripts|dist|node_modules)$/.test(src) })
  const manifestPath = path.join(dir, "manifest.json")
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  m.host_permissions = m.optional_host_permissions
  delete m.optional_host_permissions
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))
  return dir
}
