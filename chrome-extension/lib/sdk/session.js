// Session — the live SDK state, owns a WebSocket and routes frames.
//
// Public API matches design doc §4.2.
import { openWs, READY_STATE_OPEN } from "./transport.js";
import { exponentialBackoff } from "./backoff.js";
const DEFAULT_BASE_URL = "https://agentsocket.dev";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 50_000;
/** Open a session. Returns a Session object once register_reply { ok } is received. */
export async function connect(opts) {
    const session = new SessionImpl(opts);
    await session._connectAndRegister();
    return session;
}
class SessionImpl {
    baseUrl;
    appId;
    agentsMd;
    appDescription;
    // Tools by `${METHOD} ${path}` for fast dispatch
    toolsByRoute = new Map();
    toolDefs;
    autoReconnect;
    onDisconnect;
    onSessionChanged;
    heartbeatIntervalMs;
    heartbeatTimeoutMs;
    ws = null;
    _sessionId = "";
    registered = false;
    giveUpReconnect = false;
    attempt = 0;
    pendingFrameReplies = new Map();
    // Tokens we've minted in *this* session (for autoReconnect remint)
    myTokens = new Map(); // keyed by full token string
    // Heartbeat state
    heartbeatPingTimer = null;
    heartbeatTimeoutTimer = null;
    pendingPingId = null;
    constructor(opts) {
        this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.appId = opts.appId;
        this.agentsMd = opts.agentsMd;
        this.appDescription = opts.appDescription ?? "";
        this.toolDefs = opts.tools.map((t) => ({
            ...t,
            method: (t.method ?? "POST").toUpperCase(),
        }));
        for (const t of this.toolDefs) {
            this.toolsByRoute.set(`${t.method} ${t.path}`, t.handler);
        }
        this.autoReconnect = opts.autoReconnect ?? true;
        this.onDisconnect = opts.onDisconnect ?? (this.autoReconnect ? exponentialBackoff() : ({ giveUp }) => giveUp());
        this.onSessionChanged = opts.onSessionChanged;
        this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    }
    get sessionId() { return this._sessionId; }
    get connected() { return this.ws !== null && this.ws.readyState === READY_STATE_OPEN; }
    async _connectAndRegister() {
        const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/v1/_ws";
        const ws = openWs(wsUrl);
        this.ws = ws;
        try {
            await this._waitOpen(ws);
            const tools = this.toolDefs.map((t) => ({
                method: t.method,
                path: t.path,
                description: t.description,
                ...(t.input_schema !== undefined ? { input_schema: t.input_schema } : {}),
            }));
            this._sendFrame({
                type: "register",
                appId: this.appId,
                agentsMd: this.agentsMd,
                appDescription: this.appDescription,
                tools,
            });
            const reply = await this._waitForRegisterReply(ws, 10_000);
            if (!reply.ok)
                throw new Error(`register failed: ${reply.error?.code ?? "unknown"}`);
            if (this.giveUpReconnect)
                throw new Error("session closed");
            this._sessionId = reply.sessionId;
        }
        catch (e) {
            // Handlers aren't installed yet, so this close can't trigger a reconnect.
            try {
                ws.close(1000, "register failed");
            }
            catch { }
            if (this.ws === ws)
                this.ws = null;
            throw e;
        }
        this._installHandlers(ws);
        this.registered = true;
        this._scheduleNextPing();
    }
    // ── Public methods ──────────────────────────────────────────────────
    async mintAgentToken(opts) {
        const id = this._uid();
        this._sendFrame({ type: "mint_agent_token", id, label: opts.label });
        const reply = await this._awaitReply(id, 10_000);
        if (!reply.ok) {
            const code = reply.error?.code ?? "unknown";
            throw new Error(`mint failed: ${code}`);
        }
        const token = reply.token;
        const url = this._rewriteUrl(reply.url);
        const info = {
            token,
            url,
            label: reply.label ?? opts.label,
            mintedAt: Date.now(),
        };
        this.myTokens.set(token, info);
        return { token, url, label: info.label, expiresAt: reply.expiresAt ?? null };
    }
    async revokeAgentToken(token) {
        // Forget it first so a reconnect can't re-mint it. While disconnected the
        // relay has already dropped it along with the old socket.
        const known = this.myTokens.delete(token);
        if (!this.connected)
            return { ok: known };
        const id = this._uid();
        this._sendFrame({ type: "revoke_agent_token", id, token });
        const reply = await this._awaitReply(id, 10_000);
        return { ok: !!reply.ok || known };
    }
    async listAgentTokens() {
        const id = this._uid();
        this._sendFrame({ type: "list_agent_tokens", id });
        const reply = await this._awaitReply(id, 10_000);
        const tokens = reply.tokens ?? [];
        return tokens.map((t) => ({
            token: t.token,
            url: this._rewriteUrl(t.url),
            label: t.label ?? "",
            expiresAt: null,
            mintedAt: t.mintedAt ?? 0,
        }));
    }
    completeTask(taskId, result) {
        if (typeof taskId !== "string" || taskId.length === 0) {
            throw new Error("completeTask: taskId must be a non-empty string");
        }
        if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) {
            throw new Error("completeTask: WS not open");
        }
        const status = result?.status ?? 200;
        const frame = { type: "task_complete", taskId, status, body: result?.body };
        if (result?.headers && typeof result.headers === "object") {
            frame.headers = result.headers;
        }
        this._sendFrame(frame);
    }
    ping() {
        if (!this.ws || this.ws.readyState !== READY_STATE_OPEN)
            return;
        if (this.pendingPingId !== null)
            return;
        this._sendPing();
    }
    close() {
        this.giveUpReconnect = true;
        this.registered = false;
        this._teardownHeartbeat();
        this._failPending();
        try {
            this.ws?.close(1000, "client closed");
        }
        catch { }
        this.ws = null;
    }
    // ── Internals ───────────────────────────────────────────────────────
    _uid() { return Math.random().toString(36).slice(2, 12); }
    _waitOpen(ws) {
        if (ws.readyState === READY_STATE_OPEN)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const onOpen = () => { cleanup(); resolve(); };
            const onError = (e) => { cleanup(); reject(e instanceof Error ? e : new Error("ws failed to open")); };
            const onClose = () => onError(null);
            const cleanup = () => {
                ws.removeListener("open", onOpen);
                ws.removeListener("error", onError);
                ws.removeListener("close", onClose);
            };
            ws.addListener("open", onOpen);
            ws.addListener("error", onError);
            ws.addListener("close", onClose);
        });
    }
    _installHandlers(ws) {
        ws.addListener("message", (data) => { if (ws === this.ws)
            this._onMessage(String(data)); });
        ws.addListener("close", (...args) => {
            if (ws === this.ws)
                this._onClose(args[0] ?? 1006, args[1] ?? "");
        });
        ws.addListener("error", (_e) => { });
    }
    _onMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data);
        }
        catch {
            return;
        }
        this._scheduleNextPing(); // any inbound traffic resets the idle timer
        switch (msg.type) {
            case "tool_call":
                void this._handleToolCall(msg);
                return;
            case "ping":
                this._sendFrame({ type: "pong", id: msg.id });
                return;
            case "pong":
                if (msg.id === this.pendingPingId) {
                    this.pendingPingId = null;
                    if (this.heartbeatTimeoutTimer) {
                        clearTimeout(this.heartbeatTimeoutTimer);
                        this.heartbeatTimeoutTimer = null;
                    }
                }
                return;
            default: {
                if (typeof msg.id === "string") {
                    const p = this.pendingFrameReplies.get(msg.id);
                    if (p) {
                        this.pendingFrameReplies.delete(msg.id);
                        p.resolve(msg);
                        return;
                    }
                }
                // unmatched — ignore
            }
        }
    }
    async _handleToolCall(msg) {
        // Validate the frame BEFORE building the route. A malformed tool_call
        // (missing/non-string method or path) used to throw here on
        // `.toUpperCase()` — outside the try below — producing an unhandled
        // rejection (the call site is `void this._handleToolCall(msg)`) AND no
        // tool_reply, so the agent's HTTP request hung until the relay's
        // tool_timeout. Reply with an error instead so the agent gets a prompt
        // response for any frame carrying an id.
        if (typeof msg.method !== "string" || typeof msg.path !== "string") {
            if (typeof msg.id === "string") {
                this._sendFrame({
                    type: "tool_reply",
                    id: msg.id,
                    status: 400,
                    body: { error: { code: "bad_tool_call", message: "tool_call requires string method and path" } },
                });
            }
            return;
        }
        const route = `${msg.method.toUpperCase()} ${msg.path}`;
        const handler = this.toolsByRoute.get(route);
        if (!handler) {
            this._sendFrame({
                type: "tool_reply",
                id: msg.id,
                status: 404,
                body: { error: { code: "not_found", message: `no handler for ${route}` } },
            });
            return;
        }
        const ctx = {
            method: msg.method,
            path: msg.path,
            body: msg.body ?? "",
            headers: msg.headers ?? {},
        };
        try {
            const result = await handler(ctx);
            const { status, body, taskId, headers } = normalizeResult(result);
            const frame = { type: "tool_reply", id: msg.id, status, body };
            if (status === 202 && typeof taskId === "string" && taskId.length > 0) {
                frame.taskId = taskId;
            }
            if (headers && typeof headers === "object") {
                frame.headers = headers;
            }
            this._sendFrame(frame);
        }
        catch (e) {
            // Prefer a duck-typed `.message` over String(e) — handlers that throw
            // plain objects like `{message, code}` (idiomatic in older JS without
            // Error subclasses) otherwise stringify to "[object Object]".
            const eMaybe = e;
            const message = typeof eMaybe?.message === "string"
                ? eMaybe.message
                : (e instanceof Error ? e.message : String(e));
            this._sendFrame({
                type: "tool_reply",
                id: msg.id,
                status: 500,
                body: { error: { code: "handler_error", message } },
            });
        }
    }
    _onClose(_code, reason) {
        this.registered = false;
        this._teardownHeartbeat();
        this._failPending();
        this.ws = null;
        this._disconnected(reason || "ws closed");
    }
    // The single reconnect path: after a drop and after each failed attempt.
    _disconnected(reason) {
        if (this.giveUpReconnect)
            return;
        this.attempt += 1;
        let resolved = false;
        const reconnect = () => {
            if (resolved)
                return;
            resolved = true;
            // Re-check giveUpReconnect at fire-time. A consumer's onDisconnect can
            // schedule reconnect() via setTimeout (e.g. exponentialBackoff). If the
            // app calls session.close() during that delay, the timer still fires —
            // without this check it would open a brand-new WS on a closed session.
            if (this.giveUpReconnect)
                return;
            void this._reconnectAndRemint();
        };
        const giveUp = () => {
            if (resolved)
                return;
            resolved = true;
            this.giveUpReconnect = true;
        };
        void this.onDisconnect({ reason, attempt: this.attempt, reconnect, giveUp });
    }
    async _reconnectAndRemint() {
        const priorSessionId = this._sessionId;
        try {
            await this._connectAndRegister();
        }
        catch (e) {
            this._disconnected(e instanceof Error ? e.message : "reconnect failed");
            return;
        }
        this.attempt = 0;
        // The relay drops every token with the old socket. Re-mint the ones still
        // in myTokens (revoke removes them) under the new session-id.
        const tokensRemapped = new Map();
        if (!this.autoReconnect)
            this.myTokens.clear();
        for (const old of Array.from(this.myTokens.values())) {
            if (!this.myTokens.has(old.token))
                continue;
            let fresh;
            try {
                fresh = await this.mintAgentToken({ label: old.label });
            }
            catch {
                if (!this.connected)
                    break; // dropped again; the next reconnect retries the rest
                this.myTokens.delete(old.token);
                continue;
            }
            if (!this.myTokens.delete(old.token)) {
                void this.revokeAgentToken(fresh.token).catch(() => { }); // revoked while re-minting
                continue;
            }
            tokensRemapped.set(old.url, fresh.url);
        }
        if (priorSessionId !== this._sessionId && this.onSessionChanged) {
            void this.onSessionChanged({
                priorSessionId,
                sessionId: this._sessionId,
                tokensRemapped,
            });
        }
    }
    _failPending() {
        for (const p of this.pendingFrameReplies.values())
            p.reject(new Error("ws closed"));
        this.pendingFrameReplies.clear();
    }
    _sendFrame(frame) {
        if (!this.ws)
            return;
        try {
            this.ws.send(JSON.stringify(frame));
        }
        catch { }
    }
    _waitForRegisterReply(ws, timeoutMs) {
        return new Promise((resolve, reject) => {
            const done = (err, msg) => {
                clearTimeout(timer);
                ws.removeListener("message", onMessage);
                ws.removeListener("close", onClose);
                err ? reject(err) : resolve(msg);
            };
            const onMessage = (data) => {
                let msg;
                try {
                    msg = JSON.parse(String(data));
                }
                catch {
                    return;
                }
                if (msg.type === "register_reply")
                    done(null, msg);
            };
            const onClose = (...args) => done(new Error(`ws closed before register_reply (${args[0] ?? 1006})`));
            const timer = setTimeout(() => done(new Error(`register_reply timeout after ${timeoutMs}ms`)), timeoutMs);
            ws.addListener("message", onMessage);
            ws.addListener("close", onClose);
        });
    }
    _awaitReply(id, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingFrameReplies.delete(id);
                reject(new Error(`awaitReply(${id}) timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pendingFrameReplies.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
        });
    }
    _rewriteUrl(url) {
        return url.replace(/^__BASE__/, this.baseUrl);
    }
    _scheduleNextPing() {
        if (this.heartbeatPingTimer)
            clearTimeout(this.heartbeatPingTimer);
        this.heartbeatPingTimer = setTimeout(() => this._sendPing(), this.heartbeatIntervalMs);
    }
    _sendPing() {
        if (!this.ws || this.ws.readyState !== READY_STATE_OPEN)
            return;
        this.pendingPingId = this._uid();
        this._sendFrame({ type: "ping", id: this.pendingPingId });
        if (this.heartbeatTimeoutTimer)
            clearTimeout(this.heartbeatTimeoutTimer);
        this.heartbeatTimeoutTimer = setTimeout(() => {
            // No pong in window — close as dead.
            try {
                this.ws?.close(1011, "dead heartbeat");
            }
            catch { }
        }, this.heartbeatTimeoutMs);
    }
    _teardownHeartbeat() {
        if (this.heartbeatPingTimer) {
            clearTimeout(this.heartbeatPingTimer);
            this.heartbeatPingTimer = null;
        }
        if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = null;
        }
        this.pendingPingId = null;
    }
}
function normalizeResult(result) {
    if (result && typeof result === "object" && "status" in result && typeof result.status === "number") {
        const r = result;
        return { status: r.status, body: r.body, taskId: r.taskId, headers: r.headers };
    }
    return { status: 200, body: result };
}
