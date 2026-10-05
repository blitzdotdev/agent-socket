declare module 'cloudflare:test' {
    interface ProvidedEnv extends CloudflareBindings {
        TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
    }
}
