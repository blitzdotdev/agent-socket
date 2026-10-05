import {defineWorkersConfig, readD1Migrations} from '@cloudflare/vitest-pool-workers/config'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * Runs teenybase's migration generator (the one `teeny generate` uses) on
 * teenybase.ts. It is bundled with esbuild first because the published
 * teenybase dist uses extensionless relative imports, which Node's ESM loader
 * can't resolve (filed upstream in teenybase).
 */
async function generateSchemaMigrations(): Promise<{name: string, sql: string}[]> {
    const out = await build({
        stdin: {
            contents: `import {generateMigrations} from 'teenybase'\nimport config from './teenybase'\nexport const migrations = generateMigrations(config, undefined).migrations`,
            resolveDir: here, loader: 'ts',
        },
        bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
    })
    const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
    return mod.migrations
}

// Migrations are generated from teenybase.ts on every run, so tests always
// exercise the current schema and don't depend on the gitignored migrations/.
export default defineWorkersConfig(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-test-migrations-'))
    for (const m of await generateSchemaMigrations()) writeFileSync(join(dir, m.name), m.sql)
    const migrations = await readD1Migrations(dir)

    return {
        resolve: {alias: {'virtual:teenybase': fileURLToPath(new URL('./teenybase.ts', import.meta.url))}},
        test: {
            setupFiles: ['./test/apply-migrations.ts'],
            // Let vite transform teenybase (extensionless ESM imports) and its
            // `import jsep from 'jsep'` instead of loading them as externals.
            server: {deps: {inline: ['teenybase', 'jsep']}},
            poolOptions: {
                workers: {
                    main: './src/index.ts',
                    singleWorker: true,
                    isolatedStorage: true,
                    // Real bindings (D1, SUBMIT_LIMITER rate limit, vars) from wrangler.jsonc.
                    wrangler: {configPath: './wrangler.jsonc'},
                    miniflare: {
                        bindings: {
                            TEST_MIGRATIONS: migrations,
                            JWT_SECRET: 'test-jwt-secret',
                            ADMIN_JWT_SECRET: 'test-admin-jwt-secret',
                            ADMIN_SERVICE_TOKEN: 'test-admin-token',
                            IP_HASH_SECRET: 'test-ip-secret',
                            ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
                            ACCESS_AUD: 'test-aud-tag',
                            DEV_BYPASS_ACCESS: '0',
                        },
                    },
                },
            },
        },
    }
})
