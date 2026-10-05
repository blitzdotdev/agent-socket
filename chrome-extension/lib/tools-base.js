// Universal toolset — works on any website.
//
// Each tool defines a `path`, `description`, `input_schema`, and a `handler`.
// Handlers receive { body } (string) and run in the SERVICE WORKER; they act
// only on the bound tab (via `getTabId`), executing code in its MAIN world.

// ── helpers ─────────────────────────────────────────────────────────

function parseBody(body) {
  if (!body) return {}
  try { return JSON.parse(body) } catch { return { __parse_error: true, raw: body } }
}

function bad(msg, extra) {
  return { status: 400, body: { error: { code: "bad_input", message: msg, ...(extra ?? {}) } } }
}

function runtimeError(e) {
  return { status: 500, body: { error: { code: "runtime_error", message: e?.message ?? String(e) } } }
}

// SSRF / local-resource guard for AI-driven navigation. The driver is a
// remote party (the AI, via the relay), so the bound tab must not be pointed
// at the local machine, the LAN, cloud metadata, or local files. Checks the
// parsed URL's host literal only (no DNS), so it's a guardrail, not a sandbox.
function isPrivateV4([a, b]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||  // CGNAT
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function isPrivateV6(h) {
  // `new URL` has already normalized the address to hex groups.
  const [head, tail] = h.split("::")
  const hi = head ? head.split(":") : [], lo = tail ? tail.split(":") : []
  const x = (tail === undefined ? hi : [...hi, ...Array(8 - hi.length - lo.length).fill("0"), ...lo]).map((g) => parseInt(g, 16))
  const v4 = [x[6] >> 8, x[6] & 255, x[7] >> 8, x[7] & 255]
  if (x.slice(0, 5).every((g) => g === 0) && (x[5] === 0 || x[5] === 0xffff)) {
    return (x[5] === 0 && x[6] === 0) || isPrivateV4(v4)  // ::, ::1, IPv4-mapped/compatible
  }
  if (x[0] === 0x64 && x[1] === 0xff9b && x.slice(2, 6).every((g) => g === 0)) return isPrivateV4(v4)  // NAT64
  return (x[0] & 0xfe00) === 0xfc00 || (x[0] & 0xffc0) === 0xfe80  // ULA, link-local
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "")
  if (h.startsWith("[")) return isPrivateV6(h.slice(1, -1))
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateV4(h.split(".").map(Number))
  return !h.includes(".") || /\.(localhost|local|lan|internal|home\.arpa)$/.test(h)
}

// Returns null if safe, or an error message string if the URL must be rejected.
export function navUrlError(url) {
  let u
  try { u = new URL(url) } catch { return "invalid url" }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `scheme ${u.protocol} not allowed (only http/https)`
  }
  if (isPrivateHost(u.hostname)) {
    return `host ${u.hostname} is local/private and not allowed`
  }
  return null
}

// Page-side wrapper for /eval and site-profile tools: runs `code` as an async
// function body with `args` in scope, races a timeout, and serializes the
// result. Resolves to { ok, value } or { __err, __stack }.
function buildPageScript(code, args, timeoutMs) {
  return `(async () => {
  function safeSerialize(v, depth) {
    if (depth == null) depth = 0;
    if (depth > 6) return "[max depth]";
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t === "function") return "[Function " + (v.name || "anonymous") + "]";
    if (t === "bigint") return v.toString() + "n";
    if (typeof Element !== "undefined" && v instanceof Element) {
      return { __type: "Element", tag: v.tagName.toLowerCase(),
        id: v.id || undefined,
        classes: (typeof v.className === "string") ? v.className : undefined,
        text: (v.textContent || "").slice(0, 200) };
    }
    if ((typeof NodeList !== "undefined" && v instanceof NodeList) ||
        (typeof HTMLCollection !== "undefined" && v instanceof HTMLCollection)) {
      return Array.from(v).slice(0, 50).map(x => safeSerialize(x, depth + 1));
    }
    if (Array.isArray(v)) return v.slice(0, 200).map(x => safeSerialize(x, depth + 1));
    if (t === "object") {
      const out = {}; let i = 0;
      for (const k of Object.keys(v)) {
        if (i++ > 100) { out.__truncated = true; break; }
        try { out[k] = safeSerialize(v[k], depth + 1); } catch (_) { out[k] = "[unserializable]"; }
      }
      return out;
    }
    return String(v);
  }
  const args = ${JSON.stringify(args ?? {})};
  const __timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout after ${timeoutMs}ms")), ${timeoutMs}));
  const __work = (async () => {
${code}
  })();
  try {
    const value = await Promise.race([__work, __timeout]);
    return { ok: true, value: safeSerialize(value) };
  } catch (e) {
    return { __err: (e && e.message) ? e.message : String(e), __stack: e && e.stack };
  }
})()`
}

export function userScriptsAvailable() {
  // Throws when the user hasn't allowed user scripts for this extension.
  try { void chrome.userScripts.getScripts().catch(() => {}); return typeof chrome.userScripts.execute === "function" }
  catch { return false }
}

const CSP_HINT = "This site's Content Security Policy blocks running code without chrome.userScripts. Ask the user to enable it: chrome://extensions → Agent Socket → Details → 'Allow User Scripts' (Chrome 138+; on Chrome 135–137 turn on Developer mode instead)."

/**
 * Run `code` (see buildPageScript) in the tab's MAIN world. Primary path:
 * chrome.userScripts.execute injects the source directly, bypassing page CSP.
 * Fallback: scripting.executeScript + new Function(), which works on pages
 * that allow 'unsafe-eval'.
 */
async function runPageCode(tabId, code, args, timeoutMs) {
  const src = buildPageScript(code, args, timeoutMs)
  let r
  if (userScriptsAvailable()) {
    try {
      ;[r] = await chrome.userScripts.execute({ target: { tabId }, world: "MAIN", js: [{ code: src }] })
      if (r?.error) return runtimeError(new Error(typeof r.error === "string" ? r.error : (r.error.message ?? "user script error")))
    } catch { r = null /* e.g. cross-origin frame — try the fallback */ }
  }
  if (!r) {
    try {
      ;[r] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (src) => {
          try { return new Function("return " + src)() }
          catch (e) { return { __err: e?.message ?? String(e), __stack: e?.stack } }
        },
        args: [src],
      })
    } catch (e) { return runtimeError(e) }
    if (/unsafe-eval|Content Security Policy/i.test(r?.result?.__err ?? "")) {
      return { status: 400, body: { error: { code: "csp_blocked_enable_user_scripts", message: CSP_HINT, page_error: r.result.__err } } }
    }
  }
  const v = r?.result
  if (v && typeof v === "object" && v.__err) {
    return { status: 500, body: { error: { code: "runtime_error", message: v.__err, stack: v.__stack } } }
  }
  return v
}

/** Execute a function in the page's main world on the bound tab. */
async function execInPage(getTabId, fn, args, opts) {
  const tabId = await getTabId()
  if (!tabId) throw new Error("the connected tab is gone")
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: !!opts?.allFrames },
    world: "MAIN",
    func: fn,
    args: args ?? [],
  })
  if (!result) throw new Error("script returned no result")
  if (result.result && typeof result.result === "object" && result.result.__err) {
    const err = new Error(result.result.__err)
    err.stack = result.result.__stack
    throw err
  }
  return result.result
}

// ── tool factories: produce tool objects bound to a getTabId fn ─────

export function buildBaseTools({ getTabId }) {
  return [
    // ── 1. The escape hatch: raw eval ────────────────────────────────
    {
      path: "/eval",
      description:
        "Run arbitrary JavaScript in the connected tab's main world. Use this FIRST on unfamiliar sites to explore the DOM, locate selectors, and figure out what other tools you should compose. The code runs as a function body; whatever you `return` is sent back (serialized via JSON). Async: you may `return await ...`. Errors are surfaced. KEEP RESULTS SMALL — large DOM dumps are expensive; prefer targeted queries.",
      input_schema: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string", description: "JS body. Last expression value is NOT returned automatically — use `return`." },
          timeout_ms: { type: "integer", minimum: 100, maximum: 30000, default: 5000 },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (typeof args.code !== "string") return bad("expected { code: string }")
        const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 5000, 100), 30000)
        const tabId = await getTabId()
        if (!tabId) return runtimeError(new Error("the connected tab is gone"))
        return runPageCode(tabId, args.code, null, timeoutMs)
      },
    },

    // ── 2. Page info ─────────────────────────────────────────────────
    {
      path: "/page_info",
      description: "Return basic info about the connected tab: url, title, host, viewport, scroll position, document size, doc readyState, and a short text excerpt. Cheap; safe to call first.",
      input_schema: { type: "object", properties: {} },
      handler: async () => {
        try {
          const info = await execInPage(getTabId, () => ({
            url: location.href,
            host: location.host,
            title: document.title,
            readyState: document.readyState,
            viewport: { w: innerWidth, h: innerHeight },
            scroll: { x: scrollX, y: scrollY },
            doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
            text_excerpt: (document.body?.innerText || "").slice(0, 400),
          }))
          return info
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 3. DOM query ─────────────────────────────────────────────────
    {
      path: "/dom_query",
      description: "querySelectorAll on the page. Returns matched elements as { tag, id, classes, text (truncated), attrs }. Use `limit` (default 20) to cap output. `attrs` selects specific attributes (default: ['href','name','type','value','aria-label','role','placeholder']).",
      input_schema: {
        type: "object",
        required: ["selector"],
        properties: {
          selector: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
          attrs: { type: "array", items: { type: "string" } },
          text_max: { type: "integer", default: 200, minimum: 0, maximum: 5000 },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (typeof args.selector !== "string") return bad("expected { selector: string }")
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 200)
        const attrs = Array.isArray(args.attrs) ? args.attrs
          : ["href", "name", "type", "value", "aria-label", "role", "placeholder", "alt", "title"]
        const text_max = Math.min(Math.max(args.text_max ?? 200, 0), 5000)
        try {
          const result = await execInPage(getTabId, (selector, limit, attrs, textMax) => {
            let nodes
            try { nodes = document.querySelectorAll(selector) }
            catch (e) { return { __err: `bad selector: ${e.message}` } }
            const total = nodes.length
            const out = []
            for (let i = 0; i < Math.min(nodes.length, limit); i++) {
              const n = nodes[i]
              const a = {}
              for (const k of attrs) { const v = n.getAttribute(k); if (v != null) a[k] = v }
              out.push({
                tag: n.tagName.toLowerCase(),
                id: n.id || undefined,
                classes: n.className && typeof n.className === "string" ? n.className : undefined,
                attrs: Object.keys(a).length ? a : undefined,
                text: ((n.textContent || "").replace(/\s+/g, " ").trim()).slice(0, textMax),
                visible: !!(n.offsetParent || n === document.body),
              })
            }
            return { total, truncated: total > limit, matches: out }
          }, [args.selector, limit, attrs, text_max])
          return result
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 4. Click ─────────────────────────────────────────────────────
    {
      path: "/click",
      description: "Click the first element matching the selector. Returns { clicked: true, tag, text } or { clicked: false, reason }. Set `nth` to click the Nth match (0-indexed).",
      input_schema: {
        type: "object",
        required: ["selector"],
        properties: {
          selector: { type: "string" },
          nth: { type: "integer", minimum: 0, default: 0 },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (typeof args.selector !== "string") return bad("expected { selector: string }")
        try {
          const result = await execInPage(getTabId, (selector, nth) => {
            const nodes = document.querySelectorAll(selector)
            if (nodes.length <= nth) return { clicked: false, reason: `only ${nodes.length} matches for selector` }
            const el = nodes[nth]
            try { el.scrollIntoView({ block: "center", behavior: "instant" }) } catch {}
            el.click()
            return {
              clicked: true,
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || "").trim().slice(0, 80),
              url_after: location.href,
            }
          }, [args.selector, args.nth ?? 0])
          return result
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 5. Fill (input/textarea/contenteditable) ────────────────────
    {
      path: "/fill",
      description: "Fill a text input, textarea, or contenteditable. Dispatches input+change events so React/Vue see it. Replaces existing value unless append:true.",
      input_schema: {
        type: "object",
        required: ["selector", "value"],
        properties: {
          selector: { type: "string" },
          value: { type: "string" },
          append: { type: "boolean", default: false },
          submit: { type: "boolean", default: false, description: "Press Enter after filling." },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (typeof args.selector !== "string" || typeof args.value !== "string") {
          return bad("expected { selector: string, value: string }")
        }
        try {
          const result = await execInPage(getTabId, (selector, value, append, submit) => {
            const el = document.querySelector(selector)
            if (!el) return { filled: false, reason: "no match" }
            try { el.scrollIntoView({ block: "center", behavior: "instant" }) } catch {}
            try { el.focus() } catch {}
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
              const newVal = append ? (el.value + value) : value
              if (setter) setter.call(el, newVal); else el.value = newVal
              el.dispatchEvent(new Event("input", { bubbles: true }))
              el.dispatchEvent(new Event("change", { bubbles: true }))
            } else if (el.isContentEditable) {
              if (!append) el.textContent = ""
              document.execCommand?.("insertText", false, value)
              if (el.textContent !== (append ? (el.textContent) : value) && !append) el.textContent = value
              el.dispatchEvent(new Event("input", { bubbles: true }))
            } else {
              return { filled: false, reason: `element is not editable: ${el.tagName}` }
            }
            if (submit) {
              const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })
              el.dispatchEvent(ev)
              if (el.form) { try { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit() } catch {} }
            }
            return { filled: true, tag: el.tagName.toLowerCase(), value_now: el.value ?? el.textContent }
          }, [args.selector, args.value, !!args.append, !!args.submit])
          return result
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 6. Wait for selector ────────────────────────────────────────
    {
      path: "/wait_for",
      description: "Poll for a CSS selector to appear (or disappear if `absent:true`). Returns when found or timeout (default 5s).",
      input_schema: {
        type: "object",
        required: ["selector"],
        properties: {
          selector: { type: "string" },
          timeout_ms: { type: "integer", minimum: 100, maximum: 30000, default: 5000 },
          absent: { type: "boolean", default: false },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (typeof args.selector !== "string") return bad("expected { selector: string }")
        const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 5000, 100), 30000)
        const absent = !!args.absent
        try {
          const result = await execInPage(getTabId, async (selector, timeoutMs, absent) => {
            const deadline = Date.now() + timeoutMs
            while (Date.now() < deadline) {
              const el = document.querySelector(selector)
              if ((absent && !el) || (!absent && el)) {
                return {
                  found: !absent,
                  elapsed_ms: timeoutMs - (deadline - Date.now()),
                  text: el ? (el.textContent || "").trim().slice(0, 200) : null,
                }
              }
              await new Promise((r) => setTimeout(r, 50))
            }
            return { found: !absent ? false : true, timed_out: true, elapsed_ms: timeoutMs }
          }, [args.selector, timeoutMs, absent])
          return result
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 7. Navigate ─────────────────────────────────────────────────
    {
      path: "/navigate",
      description: "Navigate the connected tab to an http(s) URL. If `wait_load` is true (default), waits for the `load` event before returning. Refuses local/private-network hosts (localhost, private/link-local/CGNAT IPs, single-label and .local/.lan/.internal names) by URL only — no DNS check. This is a guardrail, not a sandbox: /eval, /click and the page itself can still navigate anywhere.",
      input_schema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          wait_load: { type: "boolean", default: true },
          timeout_ms: { type: "integer", minimum: 100, maximum: 60000, default: 15000 },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (typeof args.url !== "string") return bad("expected { url: string }")
        const urlErr = navUrlError(args.url)
        if (urlErr) return bad(urlErr)
        const wait = args.wait_load !== false
        const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 15000, 100), 60000)
        const tabId = await getTabId()
        if (!tabId) return runtimeError(new Error("the connected tab is gone"))
        await chrome.tabs.update(tabId, { url: args.url })
        if (!wait) return { navigated: true }
        // Wait for tab status = complete
        const ok = await new Promise((resolve) => {
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(false) }, timeoutMs)
          const listener = (id, info) => {
            if (id === tabId && info.status === "complete") {
              clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(true)
            }
          }
          chrome.tabs.onUpdated.addListener(listener)
        })
        const tab = await chrome.tabs.get(tabId).catch(() => null)
        return { navigated: true, loaded: ok, url: tab?.url, title: tab?.title }
      },
    },

    // ── 8. Scroll ───────────────────────────────────────────────────
    {
      path: "/scroll",
      description: "Scroll the page. Either to a selector (scrollIntoView) or by absolute pixels (x, y), or by relative pixels (dx, dy).",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          dx: { type: "number" },
          dy: { type: "number" },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        try {
          const result = await execInPage(getTabId, (a) => {
            if (a.selector) {
              const el = document.querySelector(a.selector)
              if (!el) return { scrolled: false, reason: "no match" }
              el.scrollIntoView({ block: "center", behavior: "instant" })
              return { scrolled: true, mode: "into_view" }
            }
            if (typeof a.x === "number" || typeof a.y === "number") {
              window.scrollTo({ left: a.x ?? scrollX, top: a.y ?? scrollY, behavior: "instant" })
              return { scrolled: true, mode: "absolute", scroll: { x: scrollX, y: scrollY } }
            }
            if (typeof a.dx === "number" || typeof a.dy === "number") {
              window.scrollBy({ left: a.dx ?? 0, top: a.dy ?? 0, behavior: "instant" })
              return { scrolled: true, mode: "relative", scroll: { x: scrollX, y: scrollY } }
            }
            return { scrolled: false, reason: "no selector/x/y/dx/dy given" }
          }, [args])
          return result
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 9. Get text ─────────────────────────────────────────────────
    {
      path: "/get_text",
      description: "Get the textContent of the page or a selector. Default is the whole document body (truncated to 4000 chars). Use `selector` for a region.",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          max: { type: "integer", default: 4000, minimum: 1, maximum: 200000 },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        const max = Math.min(Math.max(args.max ?? 4000, 1), 200000)
        try {
          const result = await execInPage(getTabId, (selector, max) => {
            const root = selector ? document.querySelector(selector) : document.body
            if (!root) return { text: null, reason: "no match" }
            const text = (root.innerText || root.textContent || "").replace(/\n{3,}/g, "\n\n")
            return { text: text.slice(0, max), truncated: text.length > max, length: text.length }
          }, [args.selector ?? null, max])
          return result
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 10. Get HTML ────────────────────────────────────────────────
    {
      path: "/get_html",
      description: "Return outerHTML of a selector (or document.documentElement). Truncated by default. Useful to find selectors when /dom_query isn't enough.",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          max: { type: "integer", default: 8000, minimum: 1, maximum: 200000 },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        const max = Math.min(Math.max(args.max ?? 8000, 1), 200000)
        try {
          const result = await execInPage(getTabId, (selector, max) => {
            const root = selector ? document.querySelector(selector) : document.documentElement
            if (!root) return { html: null, reason: "no match" }
            const h = root.outerHTML
            return { html: h.slice(0, max), truncated: h.length > max, length: h.length }
          }, [args.selector ?? null, max])
          return result
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 11. Screenshot ──────────────────────────────────────────────
    {
      path: "/screenshot",
      description: "Capture a PNG of the connected tab's visible viewport. Returns a data URL. Only works while the connected tab is the selected tab of its window (409 tab_not_visible otherwise). Use sparingly — large.",
      input_schema: {
        type: "object",
        properties: { format: { enum: ["png", "jpeg"], default: "png" }, quality: { type: "integer", minimum: 1, maximum: 100 } },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        const tabId = await getTabId()
        if (!tabId) return runtimeError(new Error("the connected tab is gone"))
        // captureVisibleTab grabs whatever tab is in front of the window, so
        // only capture while that is the bound tab (checked again after).
        const notVisible = { status: 409, body: { error: { code: "tab_not_visible", message: "The connected tab is not the selected tab of its window, so it can't be captured. Ask the user to switch to it." } } }
        const tab = await chrome.tabs.get(tabId)
        if (!tab.active) return notVisible
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: args.format ?? "png",
            ...(args.quality ? { quality: args.quality } : {}),
          })
          if (!(await chrome.tabs.get(tabId)).active) return notVisible
          return { data_url: dataUrl, format: args.format ?? "png", bytes: dataUrl.length }
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 12. Save profile ────────────────────────────────────────────
    {
      path: "/save_site_profile",
      description: "Persist a discovered toolset (a list of tool definitions agents can later call) keyed by hostname. Use after exploring a new site with /eval. The profile is stored in chrome.storage and surfaced as extra tools on subsequent connections to that host. NOTE: this does NOT mutate the live session; the user must reconnect for new tools to be served by the relay.",
      input_schema: {
        type: "object",
        required: ["host", "tools"],
        properties: {
          host: { type: "string", description: "Hostname e.g. 'github.com'. Matched against location.host." },
          tools: {
            type: "array",
            items: {
              type: "object",
              required: ["path", "description", "code"],
              properties: {
                method: { type: "string" },
                path: { type: "string", description: "URL path starting with /" },
                description: { type: "string" },
                input_schema: {},
                code: { type: "string", description: "JS body. Use args.<param> from input. Return value is the tool result." },
              },
            },
          },
          notes: { type: "string", description: "Optional markdown notes about the site, surfaced in agents.md." },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (typeof args.host !== "string" || !Array.isArray(args.tools)) {
          return bad("expected { host: string, tools: [...] }")
        }
        const profile = {
          host: args.host,
          tools: args.tools,
          notes: args.notes ?? "",
          savedAt: Date.now(),
        }
        const all = (await chrome.storage.local.get("site_profiles")).site_profiles ?? {}
        all[args.host] = profile
        await chrome.storage.local.set({ site_profiles: all })
        return { saved: true, host: args.host, tool_count: args.tools.length }
      },
    },
  ]
}

// ── Site-specific tool factory ──────────────────────────────────────────
// A site profile tool is { path, description, input_schema, code }. The code
// is a JS body executed in the page main world. `args` is the parsed body
// (object). Whatever it `return`s becomes the response body.

export function buildSiteTools(profile, getTabId) {
  if (!profile || !Array.isArray(profile.tools)) return []
  return profile.tools.map((t) => ({
    method: t.method,
    path: t.path,
    description: t.description,
    input_schema: t.input_schema,
    handler: async ({ body }) => {
      const tabId = await getTabId()
      if (!tabId) return runtimeError(new Error("the connected tab is gone"))
      return runPageCode(tabId, t.code, parseBody(body), 30000)
    },
  }))
}
