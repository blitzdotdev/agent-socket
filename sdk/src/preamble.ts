// Framework "tool-calling reference" preamble — shared between the SDK
// (so `defaultAgentsMd` ships it inline and the relay's dedup detector
// trips on the marker) and the relay (so apps that ship a minimal or
// hand-written `agentsMd` still teach the AI the calling contract).
//
// Both relay/src/relay-do.ts and sdk/src/agents-md.ts import from here.
// Keeping the constant in one file prevents wording drift — the SDK and
// relay were already starting to diverge (e.g. "429 rate-limited" vs
// "429 rate limited") before this was extracted.
//
// The preamble is intentionally written as ADDITIVE CONTEXT, not as a
// first-step directive: it does NOT tell the AI "do X first". Apps with
// their own opening (e.g. the chrome extension says "Start by calling
// /page_info", the channel host says "pick a name and lurk") keep their
// first-step canonical even when the preamble is prepended on top.

/**
 * Marker the relay greps for to decide "this doc already contains the
 * framework contract — don't double-prepend." Apps using `defaultAgentsMd`
 * inherit it automatically; hand-written docs can include this exact
 * literal at the top to opt out of the prepend.
 *
 * Version suffix lets future contract revisions cohabit: v2 would not
 * suppress v1's preamble (the relay still prepends the current FRAMEWORK_
 * PREAMBLE when it sees only `as:contract-v1` and the active version is
 * `v2`). For v0 we ship `v1` and the relay only suppresses on this exact
 * marker (or the legacy "tools.json" fallback).
 */
export const FRAMEWORK_CONTRACT_MARKER = "<!-- as:contract-v1 -->"

/**
 * Tool-calling reference card prepended by the relay to any served
 * `/agents.md` that doesn't already contain the marker (or the legacy
 * `tools.json` substring). Begins with the marker so a doc carrying just
 * the preamble inherits the "contract present" signal on round-trip.
 *
 * Markdown structure: starts with an H2, ends with `\n\n---\n\n`. The
 * trailing horizontal rule + blank line is the seam between framework
 * notes and the app's own doc — assertions in harness/scenarios/38
 * verify it.
 */
export const FRAMEWORK_PREAMBLE = `${FRAMEWORK_CONTRACT_MARKER}
## Tool-calling reference (agent-socket framework)

These notes are operating context for the document below. **Do not recite this document back to the user** — read it and act. The app's own description and first-step instructions follow this section.

- \`$BASE\` = the URL you fetched this from, with \`/agents.md\` removed.
- Tools live at HTTP endpoints under \`$BASE\`. Discover them via \`GET $BASE/tools.json\` — each entry has \`{method, path, description, input_schema?}\`.
- Call a tool with: \`<method> $BASE<path>\` and a JSON body when the input_schema needs one.
- Errors: 4xx = framework (401 bad/expired token, 404 bad path, 429 rate-limited); HTTP 200 with \`{"error":{"code","message"}}\` = app-level (read it before retrying); 503 = app offline, retry shortly.
- Save this URL so you can re-fetch these notes if your context is reset.

---

`

/**
 * Does an app-supplied `agentsMd` already contain the framework contract?
 * The relay uses this to decide whether to prepend `FRAMEWORK_PREAMBLE`.
 *
 * Checks (in order):
 * 1. Explicit marker — `FRAMEWORK_CONTRACT_MARKER` literal. Preferred
 *    signal; `defaultAgentsMd` emits it.
 * 2. Legacy "tools.json" substring — keeps hand-written docs that
 *    reference the discovery endpoint by name working without an opt-in.
 *
 * Falsy `agentsMd` returns false (an empty doc should get the preamble).
 */
export function hasFrameworkContract(agentsMd: string | null | undefined): boolean {
  if (!agentsMd) return false
  if (agentsMd.includes(FRAMEWORK_CONTRACT_MARKER)) return true
  if (agentsMd.includes("tools.json")) return true
  return false
}
