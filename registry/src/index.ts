import {$Database, $Env, D1Adapter, teenyHono} from 'teenybase/worker'
import config from 'virtual:teenybase'

type Env = $Env & {Bindings: CloudflareBindings}

const app = teenyHono<Env>(async (c) => new $Database(c, config, new D1Adapter(c.env.PRIMARY_DB)), undefined, {logger: false, cors: false})

export default app
