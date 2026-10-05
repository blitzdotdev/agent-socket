import {Hono} from 'hono'
import {$Database, D1Adapter, teenyHono} from 'teenybase/worker'
import config from 'virtual:teenybase'
import {api, type Env} from './api'

// teenybase owns /api/* (health, generic CRUD guarded by per-table rules,
// migrations for the CLI). The registry's own surface is /v1 (public JSON).
const app = teenyHono<Env>(
    async (c) => new $Database(c, config, new D1Adapter(c.env.PRIMARY_DB)),
    new Hono<Env>(),
    {logger: false, cors: false},
)

app.route('/v1', api)

export default app
