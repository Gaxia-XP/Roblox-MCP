/**
 * server/lib/http-bridge.mjs
 * Shared HTTP long-poll bridge primitives for the Roblox and Blender MCP servers.
 * Loopback-only HTTP with: host allowlist, optional shared-secret, body cap +
 * timeout, EADDRINUSE-fatal lifecycle, a UUID command queue with timeout +
 * late-result logging. Pure node builtins — no external deps (so `node --test`
 * runs without node_modules). Behavior must stay bit-identical to the inline
 * version that lived in server/server.mjs @ b2b4794.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

export const SENSITIVE_HEADER_RE = /^(x-api-key|x-mcp-token|authorization|x-open-cloud-api-key|.*-key)$/i;

/** Return a shallow copy of `headers` with secret values replaced by "[REDACTED]". */
export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

/** Build the loopback host allowlist for a concrete host:port. */
export function makeHostSet(host, port) {
  return new Set([`${host}:${port}`, `localhost:${port}`]);
}

/** True if the request's Host header is in the allowlist. */
export function hostAllowed(hostHeader, hosts) {
  return hosts.has(hostHeader || "");
}

/** Legacy outer-token guard set: /poll, /submit, /result/* require x-mcp-token. */
export function tokenGuarded(pathname) {
  return pathname === "/poll" || pathname === "/submit" || pathname.startsWith("/result/");
}

/**
 * Read a request body with an 8MB-class cap and a body timeout. 413 on cap,
 * 408 on timeout, single-finish guard, req.destroy on error. Extracted verbatim
 * from the inline createBridge body.
 */
export function readBody(req, res, onComplete, { maxBodyBytes, bodyTimeoutMs }) {
  let body = "";
  let bytes = 0;
  let done = false;
  const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
  const timer = setTimeout(() => {
    finish(() => {
      try { res.writeHead(408, { "Content-Type": "application/json" }); res.end('{"error":"request timeout"}'); } catch {}
      req.destroy();
    });
  }, bodyTimeoutMs);
  req.on("data", (c) => {
    if (done) return;
    bytes += c.length;
    if (bytes > maxBodyBytes) {
      finish(() => {
        try { res.writeHead(413, { "Content-Type": "application/json" }); res.end('{"error":"payload too large"}'); } catch {}
        req.destroy();
      });
      return;
    }
    body += c;
  });
  req.on("end", () => finish(() => onComplete(body)));
  req.on("error", () => finish(() => { try { req.destroy(); } catch {} }));
}

/** Attach the verbatim clientError handler (truncated/oversize-line malformed requests). */
export function attachClientError(httpServer) {
  httpServer.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
}

/**
 * Attach the FATAL listen-error handler used by the inline createBridge / inline
 * mode: EADDRINUSE (or any error) → log + process.exit(1). The broker does NOT
 * use this — it surfaces EADDRINUSE to ensureBroker as a lost election (later task).
 */
export function attachFatalListenError(httpServer, { host, port, brandPrefix }) {
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`${brandPrefix} FATAL: ${host}:${port} is already in use — another server is bound to it. Close it and retry.`);
    } else {
      console.error(`${brandPrefix} FATAL: HTTP server error: ${err.message}`);
    }
    process.exit(1);
  });
}

/**
 * Per-studio FIFO command queue: pending commands + parked long-poll waiters.
 * A waiter is a `(cmd) => boolean` responder: it res.end()s the command and
 * returns true, or throws / returns false if its socket is already dead.
 * deliverOrQueue skips dead waiters and, on a delivery that throws mid-write,
 * re-queues the command at the FRONT of pending so the next live poll gets it
 * (the §4.4 dropped-long-poll reaping fix — implemented once, shared by inline
 * createBridge and the broker).
 */
export function createCommandQueue() {
  const pending = [];
  const waiters = [];

  function deliverOrQueue(cmd) {
    while (waiters.length > 0) {
      const w = waiters.shift();
      try {
        if (w(cmd) === true) return; // delivered to a live socket
      } catch {
        // res.end threw: socket died between park and delivery.
        // Re-queue at the FRONT so the very next live poll gets this command,
        // then keep trying any remaining parked waiters.
        pending.unshift(cmd);
        return;
      }
      // w returned false (dead, no throw): drop it, try the next waiter.
    }
    pending.push(cmd);
  }

  function removePending(id) {
    const i = pending.findIndex((c) => c.id === id);
    if (i >= 0) { pending.splice(i, 1); return true; }
    return false;
  }

  // Register a long-poll responder. req 'close' reaps the parked waiter and
  // fires onAbandon() (the route clears its own poll timeout there). Returns an
  // unpark() the route calls on its own timeout/delivery so the close handler
  // becomes a no-op.
  function parkWaiter(waiterFn, req, onAbandon) {
    let removed = false;
    const remove = () => {
      if (removed) return false;
      removed = true;
      const i = waiters.indexOf(waiterFn);
      if (i >= 0) waiters.splice(i, 1);
      return true;
    };
    const onClose = () => { if (remove()) onAbandon(); };
    req.on("close", onClose);
    waiters.push(waiterFn);
    return function unpark() {
      remove();
      req.removeListener("close", onClose);
    };
  }

  return { pending, waiters, deliverOrQueue, removePending, parkWaiter };
}

export function createBridge({
  port,
  host = "127.0.0.1",
  allowedHosts,
  authToken = "",
  brandPrefix = "[mcp]",
  defaultTimeoutMs = 30_000,
  maxBodyBytes = 8 * 1024 * 1024,
  bodyTimeoutMs = 30_000,
  pollTimeoutMs = 10_000,
  pluginStaleMs = 12_000,
  onListen,
} = {}) {
  const queue = createCommandQueue();
  const inFlight = new Map();
  let lastPollAt = 0;
  // For a concrete port the allowlist is fixed up front; for port 0 (ephemeral —
  // used by tests) it is rebuilt in the listen callback once the OS assigns one.
  let hosts = allowedHosts || makeHostSet(host, port);

  function submit(type, payload, timeoutMs = defaultTimeoutMs) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const cmd = { id, type, payload };
      const timeout = setTimeout(() => {
        inFlight.delete(id);
        queue.removePending(id);
        resolve({ error: `timeout after ${timeoutMs}ms — is the ${brandPrefix} plugin/addon connected?` });
      }, timeoutMs);
      inFlight.set(id, { resolve, timeout });
      queue.deliverOrQueue(cmd);
    });
  }

  function getStatus() {
    const now = Date.now();
    const sinceLastPoll = lastPollAt === 0 ? null : now - lastPollAt;
    const pluginConnected = lastPollAt !== 0 && sinceLastPoll < pluginStaleMs;
    return {
      pluginConnected,
      msSinceLastPoll: sinceLastPoll,
      queued: queue.pending.length,
      inFlight: inFlight.size,
      ready: pluginConnected && inFlight.size === 0 && queue.pending.length === 0,
    };
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (!hostAllowed(req.headers.host, hosts)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"error":"forbidden host"}');
      return;
    }

    if (authToken && tokenGuarded(url.pathname)) {
      if (req.headers["x-mcp-token"] !== authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/poll") {
      lastPollAt = Date.now();
      if (queue.pending.length > 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(queue.pending.shift()));
        return;
      }
      let sent = false;
      let unpark;
      const timer = setTimeout(() => {
        if (sent) return;
        sent = true;
        if (unpark) unpark();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, pollTimeoutMs);
      const waiter = (cmd) => {
        if (sent) return false;
        sent = true;
        clearTimeout(timer);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cmd));
        return true;
      };
      // parkWaiter reaps this waiter (and clears `timer`) if the client drops
      // the long-poll before a command arrives.
      unpark = queue.parkWaiter(waiter, req, () => clearTimeout(timer));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/result/")) {
      const id = url.pathname.slice("/result/".length);
      readBody(req, res, (body) => {
        const handler = inFlight.get(id);
        if (handler) {
          clearTimeout(handler.timeout);
          inFlight.delete(id);
          try { handler.resolve(JSON.parse(body || "{}")); }
          catch { handler.resolve({ error: "invalid JSON from plugin" }); }
        } else {
          console.error(`late result for ${id}, op may have completed plugin-side`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      }, { maxBodyBytes, bodyTimeoutMs });
      return;
    }

    if (req.method === "POST" && url.pathname === "/submit") {
      readBody(req, res, async (body) => {
        try {
          const { type, payload } = JSON.parse(body);
          const result = await submit(type, payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"bad request"}');
        }
      }, { maxBodyBytes, bodyTimeoutMs });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queued: queue.pending.length, inFlight: inFlight.size }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/connection_status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatus()));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  attachClientError(httpServer);
  attachFatalListenError(httpServer, { host, port, brandPrefix });

  httpServer.listen(port, host, () => {
    if (!allowedHosts && port === 0) {
      const real = httpServer.address().port; // ephemeral: rebuild allowlist with the assigned port
      hosts = makeHostSet(host, real);
    }
    console.error(
      authToken
        ? `${brandPrefix} bridge on ${host}:${port} — Host-checked, shared-secret auth ENABLED.`
        : `${brandPrefix} bridge on ${host}:${port} — Host-checked. No token set: any local process can drive it.`
    );
    if (onListen) onListen();
  });

  return { httpServer, submit, getStatus };
}
