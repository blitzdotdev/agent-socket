import {applyD1Migrations, env} from 'cloudflare:test'

// Setup files run outside per-test storage isolation and may run more than
// once; applyD1Migrations only applies what's missing.
await applyD1Migrations(env.PRIMARY_DB, env.TEST_MIGRATIONS)
