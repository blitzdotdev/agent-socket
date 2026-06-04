# chrome-ext: keybind-driven `chrome.tabs.create({ url })` accepts arbitrary URL scheme

## What's wrong

The keybind flow added in commit `79897da` lets an agent register a URL against a numbered shortcut (`/configure_keybind`), and pressing the shortcut opens that URL in a background tab and binds the chrome-ext session to it.

`chrome-extension/background.js:297`:

```js
const tab = await chrome.tabs.create({ url, active: false })
```

`chrome-extension/lib/tools-base.js:678` accepts the URL as a free-form string:

```js
{
  path: "/configure_keybind",
  description: "Bind a URL to keybind slot N (1-4).",
  handler: async ({ body }) => {
    const { slot, url } = JSON.parse(body)
    // ... no scheme/host validation ...
    await chrome.storage.local.set({ [`keybind_slot_${slot}`]: url })
    return { ok: true }
  },
}
```

Chrome blocks `chrome://` and `javascript:` URLs in `tabs.create` automatically, but it does **not** block `data:`, `file:///`, `blob:`, or `chrome-extension://<other-id>/`. Concrete attack chain:

1. The user pastes the chrome-ext mint URL into an AI chat.
2. The AI (or anyone who learns the URL) calls `/configure_keybind` with `{slot: 1, url: "file:///Users/$USER/.ssh/id_rsa"}`.
3. The user presses Cmd+Shift+1. A background tab opens reading the private key file.
4. The chrome-ext binds the session to that tab. The agent now drives `/eval`, `/click`, `/get_text`, `/dom` against the tab.
5. `/eval` runs in the tab's page context — but a `file://` tab's page context can read the file's contents and ship them back via the relay.

Same shape works for any local file the user's browser can read.

`data:text/html,<...>` is also a vector: the agent crafts a page that runs JS to read DOM, abuses CSP weaknesses, fingerprints the user, etc.

## Why it matters

- The chrome-ext explicitly grants the agent privileged operations on the active tab. The keybind flow widens that to "any URL the agent chose, at any moment after install."
- The MV3 manifest already opted into `<all_urls>` host permissions, so once a tab is open and bound, the agent has full extension-level scripting on it.
- The pre-keybind flow was safer because the user had to choose which tab to bind (they pressed "Connect this tab" on the active tab). The keybind path removes that consent.

## What to do

1. **Scheme allowlist in `/configure_keybind`.** Reject anything not `http:` or `https:`:

   ```js
   const allowed = new Set(["http:", "https:"])
   let u
   try { u = new URL(url) } catch { return err400("bad_input", "url must be a valid absolute URL") }
   if (!allowed.has(u.protocol)) {
     return err400("bad_input", `url scheme ${u.protocol} not allowed; use http(s):`)
   }
   ```

2. **Reject `localhost` / private-network URLs unless explicitly opted in.** A keybind to `http://localhost:6379/` lets the agent prod the user's local Redis (etc). The chrome ext's SECURITY.md should document this. Probably block all of:
   - `localhost`, `127.0.0.0/8`, `::1`
   - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
   - `169.254.0.0/16` (link-local; the AWS-instance-metadata-on-laptop trap)
   - `*.local`

   Same rule as SSRF defenses on a public web service. Opt-in via a `--allow-private-network` install flag if the user really wants to drive their local apps.

3. **Confirmation prompt on first keybind press to a new URL.** Even with the scheme allowlist, the user should see "agent-socket: open `https://example.com` in a background tab?" the first time a given URL is bound, with a "remember for this URL" checkbox. This catches social-engineering ("paste this URL into your AI chat to win a prize → you set up a keybind to evil.com").

4. **Validate before storing AND before opening.** Today `keybind_slot_N` storage isn't validated. A stored bad URL would survive the new check. Validate both at storage time AND at open time (`background.js:297`).

## Acceptance

- `/configure_keybind` with `url: "file:///etc/passwd"` returns 400 `bad_input`.
- Same for `data:`, `blob:`, `chrome-extension://other-id`.
- `/configure_keybind` with `url: "http://localhost:8080"` returns 400 unless private-network is enabled.
- Existing keybinds in `chrome.storage.local` that were stored before the validation lands are revalidated on the next `chrome.commands.onCommand` fire; invalid stored URLs are removed with a notification.
- New harness scenario (or chrome-ext test) exercises the rejection path.

## Provenance

Caught 2026-06-04 during the post-merge audit. The keybind flow was added in commit `79897da` ("bridge") with no scheme/host validation.
