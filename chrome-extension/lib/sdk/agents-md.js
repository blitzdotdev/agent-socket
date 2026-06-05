// defaultAgentsMd helper — emits a standard agents.md template that
// app authors can use to brief any AI joining their app. App-specific
// app name / description / capabilities / conventions are injected.
//
// NOTE: you don't strictly need this — the relay prepends a canonical "how to call
// tools" contract (do-not-recite, $BASE, GET $BASE/tools.json, POST $BASE/<path>) to
// any served agents.md that doesn't already include it. So a custom agentsMd can be
// app-content-only and the agent will still drive the app. This template embeds
// the FRAMEWORK_PREAMBLE (with its marker) at the top so the relay won't double
// it up — single source of truth for the contract lives in ./preamble.ts.
import { FRAMEWORK_PREAMBLE } from "./preamble.js";
export function defaultAgentsMd(opts) {
    const caps = (opts.capabilities ?? ["Call any tool listed in tools.json"])
        .map((c) => `- ${c}`)
        .join("\n");
    const lims = (opts.limitations ?? [])
        .map((c) => `- ${c}`)
        .join("\n") || "_none specified_";
    const conventions = opts.conventions ?? "Read tools.json before any write.";
    // FRAMEWORK_PREAMBLE owns the calling contract + marker; what we emit
    // here is app-content-only. The relay's dedup detects the embedded
    // marker and skips its own prepend, so the served doc has the contract
    // exactly once.
    return `${FRAMEWORK_PREAMBLE}# ${opts.appName}

${opts.appDescription}

**Save this URL** in case your context is compacted: \`${opts.agentsMdUrl}\`

## What you can do
${caps}

## What you cannot do
${lims}

## Conventions
${conventions}
`;
}
