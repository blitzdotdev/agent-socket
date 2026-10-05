// Flags code patterns a reviewer should look at closely. This is a review aid,
// not a security boundary: obfuscated code can evade any pattern list, which
// is exactly why "obfuscation" patterns are flagged too.

export type Severity = 'high' | 'medium' | 'low'

export interface RiskRule {
    id: string
    severity: Severity
    label: string
    re: RegExp
}

export const RISK_RULES: RiskRule[] = [
    // Exfiltration / network
    {id: 'fetch', severity: 'high', label: 'network request (fetch)', re: /\bfetch\s*\(/g},
    {id: 'xhr', severity: 'high', label: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/g},
    {id: 'beacon', severity: 'high', label: 'sendBeacon', re: /\bsendBeacon\s*\(/g},
    {id: 'socket', severity: 'high', label: 'WebSocket / EventSource', re: /\bnew\s+(?:WebSocket|EventSource)\b/g},
    {id: 'img-src', severity: 'high', label: 'image/script src set (possible exfil)', re: /\.src\s*=(?!=)/g},
    // Credentials / storage
    {id: 'cookie', severity: 'high', label: 'document.cookie', re: /\bdocument\s*\.\s*cookie\b/g},
    {id: 'storage', severity: 'high', label: 'local/session storage', re: /\b(?:localStorage|sessionStorage)\b/g},
    {id: 'idb', severity: 'medium', label: 'IndexedDB', re: /\bindexedDB\b/g},
    {id: 'password', severity: 'high', label: 'password field', re: /type\s*=\s*\\?["']?password|\bpassword\b/gi},
    // Dynamic code
    {id: 'eval', severity: 'high', label: 'eval()', re: /\beval\s*\(/g},
    {id: 'new-function', severity: 'high', label: 'new Function / Function()', re: /\bnew\s+Function\b|\bFunction\s*\(/g},
    {id: 'string-timer', severity: 'medium', label: 'setTimeout/setInterval with string', re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g},
    {id: 'import', severity: 'high', label: 'dynamic import()', re: /\bimport\s*\(/g},
    {id: 'script-inject', severity: 'high', label: 'creates <script>', re: /createElement\s*\(\s*["'`]script/gi},
    // Obfuscation
    {id: 'b64', severity: 'medium', label: 'base64 (atob/btoa)', re: /\b(?:atob|btoa)\s*\(/g},
    {id: 'charcode', severity: 'medium', label: 'String.fromCharCode', re: /\bfromCharCode\b/g},
    {id: 'hex-escape', severity: 'medium', label: 'hex/unicode escapes', re: /(?:\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}){3,}/g},
    // Cross-context / navigation
    {id: 'postmessage', severity: 'medium', label: 'postMessage', re: /\bpostMessage\s*\(/g},
    {id: 'window-open', severity: 'medium', label: 'window.open', re: /\bwindow\s*\.\s*open\s*\(/g},
    {id: 'location-set', severity: 'medium', label: 'navigates (location set)', re: /\blocation(?:\s*\.\s*href)?\s*=(?!=)|\blocation\s*\.\s*(?:assign|replace)\s*\(/g},
    {id: 'chrome-api', severity: 'high', label: 'chrome.* extension API', re: /\bchrome\s*\.\s*[a-z]/g},
    {id: 'clipboard', severity: 'medium', label: 'clipboard access', re: /\bclipboard\b|execCommand\s*\(\s*["'](?:copy|paste|cut)/gi},
    // Side effects on the user's account
    {id: 'submit', severity: 'medium', label: 'form submit', re: /\.submit\s*\(|\brequestSubmit\s*\(/g},
    {id: 'click', severity: 'low', label: 'synthetic click', re: /\.click\s*\(\s*\)/g},
    {id: 'dispatch', severity: 'low', label: 'dispatches events', re: /\bdispatchEvent\s*\(/g},
    {id: 'inner-html', severity: 'low', label: 'innerHTML write', re: /\.(?:innerHTML|outerHTML)\s*=(?!=)/g},
]

/** Words in a tool path/description suggesting it acts on the user's behalf. */
export const ACTION_WORDS = /\b(?:send|sends|post|posts|posting|submit|publish|reply|replies|dm|dms|message|tweet|retweet|like|upvote|downvote|vote|delete|remove|follow|unfollow|purchase|buy|pay|transfer|invite)\b/i

export interface RiskHit { rule: RiskRule, index: number, length: number }

export function findRisks(code: string): RiskHit[] {
    const hits: RiskHit[] = []
    for (const rule of RISK_RULES) {
        rule.re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = rule.re.exec(code))) {
            if (!m[0].length) { rule.re.lastIndex++; continue }
            hits.push({rule, index: m.index, length: m[0].length})
        }
    }
    // Keep the first, highest-severity match where they overlap.
    const rank = {high: 0, medium: 1, low: 2}
    hits.sort((x, y) => x.index - y.index || rank[x.rule.severity] - rank[y.rule.severity])
    const out: RiskHit[] = []
    let end = -1
    for (const h of hits) { if (h.index >= end) { out.push(h); end = h.index + h.length } }
    return out
}

export interface RiskSummary { high: number, medium: number, low: number, labels: string[], actions: boolean }

export function summarize(tools: {path: string, description: string, code: string}[]): RiskSummary {
    const s: RiskSummary = {high: 0, medium: 0, low: 0, labels: [], actions: false}
    const labels = new Set<string>()
    for (const t of tools) {
        for (const h of findRisks(t.code)) { s[h.rule.severity]++; labels.add(h.rule.label) }
        if (ACTION_WORDS.test(t.path.replace(/[_/.-]/g, ' ')) || ACTION_WORDS.test(t.description)) s.actions = true
    }
    s.labels = [...labels]
    return s
}

/** Tool-level: does this tool look like it acts on the user's behalf? */
export function isActionTool(t: {path: string, description: string}) {
    return ACTION_WORDS.test(t.path.replace(/[_/.-]/g, ' ')) || ACTION_WORDS.test(t.description)
}
