// The heartbeat frames, byte for byte. The relay registers this pair with
// the Durable Object runtime (setWebSocketAutoResponse), which answers the
// ping itself without waking a hibernated session; that only works for an
// exact string match, so the SDK sends exactly HEARTBEAT_PING. Relays that
// predate auto-response answer it like any ping ({type:"pong", id}), which is
// the same string.
export const HEARTBEAT_ID = "as_hb"
export const HEARTBEAT_PING = `{"type":"ping","id":"${HEARTBEAT_ID}"}`
export const HEARTBEAT_PONG = `{"type":"pong","id":"${HEARTBEAT_ID}"}`
