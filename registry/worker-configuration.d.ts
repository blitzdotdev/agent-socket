// Worker bindings (mirrors wrangler.jsonc + .dev.vars).
interface CloudflareBindings {
    PRIMARY_DB: D1Database
    SUBMIT_LIMITER?: RateLimit
    ACCESS_TEAM_DOMAIN?: string
    ACCESS_AUD?: string
    DEV_BYPASS_ACCESS?: string
    IP_HASH_SECRET?: string
    SUBMISSIONS_PER_IP_PER_DAY?: string
    MAX_PENDING_SUBMISSIONS?: string
}
