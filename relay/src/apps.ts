// App registry. Reads `apps.json` from the bundle at module load.
// In v0 this is a static file checked into the repo; future versions may
// support a registration API or DB.

import type { AppEntry, AppsRegistry } from "./types"
import appsJson from "../apps.json"

const apps = appsJson as AppsRegistry

/** Lookup an app entry by app-id. Returns null if unknown. */
export function lookupApp(appId: string): AppEntry | null {
  return apps[appId] ?? null
}

/**
 * Origin check. Returns true if the request's Origin matches the app's
 * allowedOrigins, or if "*" is in allowedOrigins (matches any value, also
 * matches absent Origin).
 *
 * Browsers always send Origin on cross-origin WS handshakes; non-browser
 * clients (Node `ws`, CLIs) usually don't. Same-origin browser WS may
 * also omit it. With "*" we accept all of those.
 */
export function checkOrigin(entry: AppEntry, origin: string | null): boolean {
  if (entry.allowedOrigins.includes("*")) return true
  if (!origin) return false
  return entry.allowedOrigins.includes(origin)
}
