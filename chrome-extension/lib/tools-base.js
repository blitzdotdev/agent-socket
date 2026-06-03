// Universal toolset — works on any website.
//
// Each tool defines a `path`, `description`, `input_schema`, and a `handler`.
// Handlers receive { body } (string) and a `tabCtx` accessor for the active tab.
// They run in the SERVICE WORKER and use chrome.scripting to execute code
// in the page's MAIN world.

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

/**
 * Build a JS source string for chrome.userScripts.execute.
 * Inlines safeSerialize so the script is self-contained, wraps the user's
 * code in an async IIFE so `return` works, and races against a timeout.
 * The returned promise resolves to { ok, value } or { __err, __stack }.
 */
function buildEvalScript(userCode, timeoutMs) {
  // Note: userCode is inlined directly into the script source (no new Function()),
  // which is the whole point — that's why this path bypasses page CSP.
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
  const __timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("eval timeout")), ${timeoutMs}));
  const __work = (async () => {
${userCode}
  })();
  try {
    const value = await Promise.race([__work, __timeout]);
    return { ok: true, value: safeSerialize(value) };
  } catch (e) {
    return { __err: (e && e.message) ? e.message : String(e), __stack: e && e.stack };
  }
})()`
}

/** Execute a function in the page's main world on the active tab. */
async function execInPage(getActiveTabId, fn, args, opts) {
  const tabId = await getActiveTabId()
  if (!tabId) throw new Error("no active tab")
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

/**
 * Build a JS source string for a site-profile tool. Mirrors `buildEvalScript`
 * but exposes an `args` const (the parsed body) inside the user code. Inlined
 * directly into a user-scripts execution so it bypasses page CSP — required
 * for strict-CSP sites like reddit.com that block scripting.executeScript's
 * `new Function()` path with the 'unsafe-eval' policy.
 */
function buildSiteToolScript(userCode, args, timeoutMs) {
  // args is the parsed JSON body — serialize it via JSON.stringify so it lands
  // in the page as a plain object const. Same safeSerialize as /eval.
  const argsLiteral = JSON.stringify(args ?? {})
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
  const args = ${argsLiteral};
  const __timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("site tool timeout")), ${timeoutMs}));
  const __work = (async () => {
${userCode}
  })();
  try {
    const value = await Promise.race([__work, __timeout]);
    return { ok: true, value: safeSerialize(value) };
  } catch (e) {
    return { __err: (e && e.message) ? e.message : String(e), __stack: e && e.stack };
  }
})()`
}

// ── tool factories: produce tool objects bound to a getActiveTabId fn ─────

export function buildBaseTools({ getActiveTabId, getRecentConsole, getRecentNetwork }) {
  return [
    // ── 1. The escape hatch: raw eval ────────────────────────────────
    {
      path: "/eval",
      description:
        "Run arbitrary JavaScript in the page's main world. Use this FIRST on unfamiliar sites to explore the DOM, locate selectors, and figure out what other tools you should compose. The code runs as a function body; whatever you `return` is sent back (serialized via JSON). Async: you may `return await ...`. Errors are surfaced. KEEP RESULTS SMALL — large DOM dumps are expensive; prefer targeted queries.",
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
        const tabId = await getActiveTabId()
        if (!tabId) return runtimeError(new Error("no active tab"))

        // Primary path: chrome.userScripts.execute injects raw source via the
        // user-scripts world, which bypasses the page's CSP entirely (no
        // 'unsafe-eval' needed). Requires the user to have toggled "Allow User
        // Scripts" on this extension in chrome://extensions.
        if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
          try {
            const wrapped = buildEvalScript(args.code, timeoutMs)
            const results = await chrome.userScripts.execute({
              target: { tabId },
              world: "MAIN",
              js: [{ code: wrapped }],
            })
            const r = Array.isArray(results) ? results[0] : null
            if (r?.error) return runtimeError(new Error(typeof r.error === "string" ? r.error : (r.error.message ?? "user script error")))
            const v = r?.result
            if (v && typeof v === "object" && v.__err) {
              return { status: 500, body: { error: { code: "runtime_error", message: v.__err, stack: v.__stack } } }
            }
            return v
          } catch (e) {
            const msg = e?.message ?? String(e)
            if (/user scripts? api is not allowed|user scripts? not allowed|developer mode|allow user scripts/i.test(msg)) {
              return {
                status: 400,
                body: { error: {
                  code: "user_scripts_not_enabled",
                  message: "chrome.userScripts is disabled on this extension. /eval is blocked by site CSP without it. Enable: open chrome://extensions, find 'Agent Socket', click Details, toggle 'Allow User Scripts' on, then reconnect this tab from the extension popup.",
                } },
              }
            }
            // Other failure (e.g. cross-origin frame) — fall through to the
            // scripting.executeScript path which still works for sites without
            // strict CSP and surfaces a more useful error for those that do.
          }
        }

        // Fallback: scripting.executeScript with new Function(). Works on any
        // site that doesn't ban 'unsafe-eval'. Sites like x.com, github.com,
        // accounts.google.com will fail here — the error surfaces back to the
        // agent so it can tell the user to enable user scripts.
        try {
          const result = await execInPage(getActiveTabId, async (code, timeoutMs) => {
            try {
              const AsyncFn = (async function () {}).constructor
              const fn = new AsyncFn(code)
              const p = Promise.resolve(fn())
              const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("eval timeout")), timeoutMs))
              const value = await Promise.race([p, timeout])
              return { ok: true, value: safeSerialize(value) }
            } catch (e) {
              return { __err: e?.message ?? String(e), __stack: e?.stack }
            }
            function safeSerialize(v, depth = 0) {
              if (depth > 6) return "[max depth]"
              if (v === null || v === undefined) return v
              const t = typeof v
              if (t === "string" || t === "number" || t === "boolean") return v
              if (t === "function") return `[Function ${v.name || "anonymous"}]`
              if (t === "bigint") return v.toString() + "n"
              if (v instanceof Element) {
                return {
                  __type: "Element",
                  tag: v.tagName.toLowerCase(),
                  id: v.id || undefined,
                  classes: v.className && typeof v.className === "string" ? v.className : undefined,
                  text: (v.textContent || "").slice(0, 200),
                }
              }
              if (v instanceof NodeList || v instanceof HTMLCollection) {
                return Array.from(v).slice(0, 50).map((x) => safeSerialize(x, depth + 1))
              }
              if (Array.isArray(v)) return v.slice(0, 200).map((x) => safeSerialize(x, depth + 1))
              if (t === "object") {
                const out = {}
                let i = 0
                for (const k of Object.keys(v)) {
                  if (i++ > 100) { out["__truncated"] = true; break }
                  try { out[k] = safeSerialize(v[k], depth + 1) } catch { out[k] = "[unserializable]" }
                }
                return out
              }
              return String(v)
            }
          }, [args.code, timeoutMs])
          return result
        } catch (e) {
          const msg = e?.message ?? String(e)
          // The classic CSP-strict-site error — point the agent at the fix.
          if (/unsafe-eval|Content Security Policy/i.test(msg)) {
            return {
              status: 400,
              body: { error: {
                code: "csp_blocked_enable_user_scripts",
                message: "This site's Content Security Policy blocks the fallback /eval path, and chrome.userScripts is not enabled. To run /eval here: open chrome://extensions, find 'Agent Socket', click Details, toggle 'Allow User Scripts' on, then reconnect this tab.",
                page_error: msg,
              } },
            }
          }
          return runtimeError(e)
        }
      },
    },

    // ── 2. Page info ─────────────────────────────────────────────────
    {
      path: "/page_info",
      description: "Return basic info about the active tab: url, title, host, viewport, scroll position, document size, doc readyState, and a short text excerpt. Cheap; safe to call first.",
      input_schema: { type: "object", properties: {} },
      handler: async () => {
        try {
          const info = await execInPage(getActiveTabId, () => ({
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
          const result = await execInPage(getActiveTabId, (selector, limit, attrs, textMax) => {
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
          const result = await execInPage(getActiveTabId, (selector, nth) => {
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
          const result = await execInPage(getActiveTabId, (selector, value, append, submit) => {
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
          const result = await execInPage(getActiveTabId, async (selector, timeoutMs, absent) => {
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
      description: "Navigate the active tab to a URL. If `wait_load` is true (default), waits for `load` event before returning.",
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
        const wait = args.wait_load !== false
        const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 15000, 100), 60000)
        const tabId = await getActiveTabId()
        if (!tabId) return runtimeError(new Error("no active tab"))
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
          const result = await execInPage(getActiveTabId, (a) => {
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
          const result = await execInPage(getActiveTabId, (selector, max) => {
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
          const result = await execInPage(getActiveTabId, (selector, max) => {
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
      description: "Capture a PNG of the visible viewport of the active tab. Returns a data URL. Use sparingly — large.",
      input_schema: {
        type: "object",
        properties: { format: { enum: ["png", "jpeg"], default: "png" }, quality: { type: "integer", minimum: 1, maximum: 100 } },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        const tabId = await getActiveTabId()
        if (!tabId) return runtimeError(new Error("no active tab"))
        const tab = await chrome.tabs.get(tabId)
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: args.format ?? "png",
            ...(args.quality ? { quality: args.quality } : {}),
          })
          return { data_url: dataUrl, format: args.format ?? "png", bytes: dataUrl.length }
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 12. Tabs list ───────────────────────────────────────────────
    {
      path: "/tabs_list",
      description: "List open tabs in the current Chrome window. Returns id, url, title, active.",
      input_schema: { type: "object", properties: {} },
      handler: async () => {
        try {
          const tabs = await chrome.tabs.query({ currentWindow: true })
          return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
        } catch (e) { return runtimeError(e) }
      },
    },

    // ── 13. Tabs switch ─────────────────────────────────────────────
    {
      path: "/tabs_switch",
      description: "Switch the active tab to one by id. Subsequent tool calls operate on it.",
      input_schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (typeof args.id !== "number") return bad("expected { id: integer }")
        try { await chrome.tabs.update(args.id, { active: true }); return { switched: true, id: args.id } }
        catch (e) { return runtimeError(e) }
      },
    },

    // ── 14. Console log ─────────────────────────────────────────────
    {
      path: "/console_recent",
      description: "Return the most recent N console messages from the active tab (captured by the extension).",
      input_schema: { type: "object", properties: { limit: { type: "integer", default: 50, maximum: 500 } } },
      handler: async ({ body }) => {
        const args = parseBody(body)
        const limit = Math.min(args.limit ?? 50, 500)
        const tabId = await getActiveTabId()
        return { messages: getRecentConsole(tabId, limit) }
      },
    },

    // ── 15a. Configure a keybind slot ───────────────────────────────
    {
      path: "/configure_keybind",
      description:
        "Bind a keybind slot (1..4) to a URL. The user has 4 Chrome keyboard-shortcut slots; this tool sets which URL each one opens. When the user presses the slot's shortcut, the extension opens that URL in a BACKGROUND tab (no focus steal), mints a fresh agent-socket session against it, copies the session URL to the system clipboard, and surfaces a desktop notification. Pass an empty string for `url` to clear a slot. NOTE: the user must one-time assign actual keystrokes at chrome://extensions/shortcuts — this tool only sets the slot→URL mapping. Use /list_keybinds first to see what's already bound.",
      input_schema: {
        type: "object",
        required: ["slot", "url"],
        properties: {
          slot: { type: "integer", minimum: 1, maximum: 4, description: "Slot number 1..4." },
          url: { type: "string", description: "Full URL, e.g. https://www.reddit.com. Empty string clears the slot." },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (!Number.isInteger(args.slot) || args.slot < 1 || args.slot > 4) {
          return bad("expected { slot: 1..4 }")
        }
        if (typeof args.url !== "string") return bad("expected { url: string }")
        const all = (await chrome.storage.local.get("keybind_slots")).keybind_slots ?? {}
        if (args.url === "") delete all[String(args.slot)]
        else all[String(args.slot)] = args.url
        await chrome.storage.local.set({ keybind_slots: all })
        let shortcut = null
        try {
          const cmds = await chrome.commands.getAll()
          shortcut = cmds.find((c) => c.name === `connect-slot-${args.slot}`)?.shortcut || null
        } catch {}
        return {
          slot: args.slot,
          url: args.url,
          slots: all,
          shortcut,
          note: shortcut
            ? `Slot ${args.slot} bound. Press ${shortcut} to mint a session.`
            : `Slot ${args.slot} bound, but no keystroke is assigned to it yet. User: open chrome://extensions/shortcuts and assign a key for "agent-socket: connect slot ${args.slot}".`,
        }
      },
    },

    // ── 15b. List configured keybinds ───────────────────────────────
    {
      path: "/list_keybinds",
      description:
        "Return the current keybind slot→URL mapping and the actual Chrome keystrokes assigned (if any). Use to check what's configured before (re)binding a slot, or to tell the user which keystroke to press for a given site.",
      input_schema: { type: "object", properties: {} },
      handler: async () => {
        const slots = (await chrome.storage.local.get("keybind_slots")).keybind_slots ?? {}
        let commands = []
        try { commands = await chrome.commands.getAll() } catch {}
        const summary = [1, 2, 3, 4].map((n) => {
          const cmd = commands.find((c) => c.name === `connect-slot-${n}`)
          return {
            slot: n,
            url: slots[String(n)] ?? null,
            shortcut: cmd?.shortcut || null,
          }
        })
        return { slots: summary }
      },
    },

    // ── 16. Save profile ────────────────────────────────────────────
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

export function buildSiteTools(profile, getActiveTabId) {
  if (!profile || !Array.isArray(profile.tools)) return []
  return profile.tools.map((t) => ({
    method: t.method,
    path: t.path,
    description: t.description,
    input_schema: t.input_schema,
    handler: async ({ body }) => {
      const args = parseBody(body)
      const timeoutMs = 30000
      const tabId = await getActiveTabId()
      if (!tabId) return runtimeError(new Error("no active tab"))

      // Primary path: chrome.userScripts.execute injects raw source via the
      // user-scripts world, which bypasses the page's CSP entirely (no
      // 'unsafe-eval' needed). Required for strict-CSP sites like reddit.com.
      // Requires the user to have toggled "Allow User Scripts" on this
      // extension in chrome://extensions.
      if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
        try {
          const wrapped = buildSiteToolScript(t.code, args, timeoutMs)
          const results = await chrome.userScripts.execute({
            target: { tabId },
            world: "MAIN",
            js: [{ code: wrapped }],
          })
          const r = Array.isArray(results) ? results[0] : null
          if (r?.error) return runtimeError(new Error(typeof r.error === "string" ? r.error : (r.error.message ?? "user script error")))
          const v = r?.result
          if (v && typeof v === "object" && v.__err) {
            return { status: 500, body: { error: { code: "runtime_error", message: v.__err, stack: v.__stack } } }
          }
          return v
        } catch (e) {
          const msg = e?.message ?? String(e)
          if (/user scripts? api is not allowed|user scripts? not allowed|developer mode|allow user scripts/i.test(msg)) {
            return {
              status: 400,
              body: { error: {
                code: "user_scripts_not_enabled",
                message: "chrome.userScripts is disabled on this extension. Site-specific tools are blocked by site CSP without it. Enable: open chrome://extensions, find 'Agent Socket', click Details, toggle 'Allow User Scripts' on, then reconnect this tab from the extension popup.",
              } },
            }
          }
          // Other failure (e.g. cross-origin frame) — fall through to the
          // scripting.executeScript path. Works on any site without strict CSP.
        }
      }

      // Fallback: scripting.executeScript with new Function(). Hits page CSP
      // on strict-CSP sites (reddit.com, x.com, github.com), but the resulting
      // error message points the agent at the user-scripts toggle.
      try {
        const result = await execInPage(getActiveTabId, async (code, args) => {
          try {
            const AsyncFn = (async function () {}).constructor
            const fn = new AsyncFn("args", code)
            return { ok: true, value: await fn(args) }
          } catch (e) {
            return { __err: e?.message ?? String(e), __stack: e?.stack }
          }
        }, [t.code, args])
        return result
      } catch (e) {
        const msg = e?.message ?? String(e)
        if (/unsafe-eval|Content Security Policy/i.test(msg)) {
          return {
            status: 400,
            body: { error: {
              code: "csp_blocked_enable_user_scripts",
              message: "This site's CSP blocks the fallback site-tool path, and chrome.userScripts is not enabled. To run site tools here: open chrome://extensions, find 'Agent Socket', click Details, toggle 'Allow User Scripts' on, then reconnect this tab.",
              page_error: msg,
            } },
          }
        }
        return runtimeError(e)
      }
    },
  }))
}
