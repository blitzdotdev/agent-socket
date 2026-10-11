// WebSocket transport over the runtime's native WebSocket (browsers, Workers,
// Node 22+). Wraps it in a minimal send/close/addListener surface.
const READY_OPEN = 1;
export function openWs(url) {
    const Native = globalThis.WebSocket;
    if (!Native)
        throw new Error("No global WebSocket — agent-socket needs a browser, Workers, or Node 22+.");
    return wrapNative(new Native(url));
}
function wrapNative(ws) {
    // Map our addListener/removeListener naming to addEventListener/removeEventListener
    // and adapt event objects to the listener signatures the SDK expects.
    const adapters = new WeakMap();
    return {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        get readyState() { return ws.readyState; },
        addListener: (event, fn) => {
            let adapter;
            switch (event) {
                case "message":
                    adapter = (ev) => fn(ev.data);
                    break;
                case "close":
                    adapter = (ev) => {
                        const ce = ev;
                        fn(ce.code, ce.reason);
                    };
                    break;
                case "error":
                    adapter = (ev) => fn(ev);
                    break;
                case "open":
                default:
                    adapter = () => fn();
                    break;
            }
            adapters.set(fn, adapter);
            ws.addEventListener(event, adapter);
        },
        removeListener: (event, fn) => {
            const adapter = adapters.get(fn);
            if (adapter)
                ws.removeEventListener(event, adapter);
        },
    };
}
export const READY_STATE_OPEN = READY_OPEN;
