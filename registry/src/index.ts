import {Hono} from 'hono'
import {$Database, D1Adapter, teenyHono} from 'teenybase/worker'
import config from 'virtual:teenybase'
import {api, type Env} from './api'
import {admin} from './admin/routes'

// teenybase owns /api/* (health, generic CRUD guarded by per-table rules,
// migrations for the CLI). The registry's own surface is /v1 (public JSON)
// and /admin (Cloudflare Access protected SSR).
const app = teenyHono<Env>(
    async (c) => new $Database(c, config, new D1Adapter(c.env.PRIMARY_DB)),
    new Hono<Env>(),
    {logger: false, cors: false},
)

app.route('/v1', api)
app.route('/admin', admin as unknown as Hono<Env>)

app.get('/', (c) => c.json({
    name: 'agent-socket registry',
    docs: 'https://github.com/blitzdotdev/agent-socket/tree/master/registry',
    endpoints: ['GET /v1/sites', 'GET /v1/sites/:host', 'GET /v1/search?q=', 'POST /v1/submissions'],
}))

export default app
