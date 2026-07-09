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

const SENSITIVE_HEADER_RE = /^(x-api-key|x-mcp-token|authorization|x-open-cloud-api-key|.*-key)$/i;

/** Return a shallow copy of `headers` with secret values replaced by "[REDACTED]". */
export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? "[REDACTED]" : v;
  }
  return out;
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
  const pending = [];
  const inFlight = new Map();
  const waiters = [];
  let lastPollAt = 0;
  // For a concrete port the allowlist is fixed up front; for port 0 (ephemeral —
  // used by tests) it is rebuilt in the listen callback once the OS assigns one.
  let hosts = allowedHosts || new Set([`${host}:${port}`, `localhost:${port}`]);

  function submit(type, payload, timeoutMs = defaultTimeoutMs) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const cmd = { id, type, payload };
      const timeout = setTimeout(() => {
        inFlight.delete(id);
        const qi = pending.findIndex((c) => c.id === id);
        if (qi >= 0) pending.splice(qi, 1);
        resolve({ error: `timeout after ${timeoutMs}ms — is the ${brandPrefix} plugin/addon connected?` });
      }, timeoutMs);
      inFlight.set(id, { resolve, timeout });
      if (waiters.length > 0) waiters.shift()(cmd);
      else pending.push(cmd);
    });
  }

  function readBody(req, res, onComplete) {
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

  function getStatus() {
    const now = Date.now();
    const sinceLastPoll = lastPollAt === 0 ? null : now - lastPollAt;
    const pluginConnected = lastPollAt !== 0 && sinceLastPoll < pluginStaleMs;
    return {
      pluginConnected,
      msSinceLastPoll: sinceLastPoll,
      queued: pending.length,
      inFlight: inFlight.size,
      ready: pluginConnected && inFlight.size === 0 && pending.length === 0,
    };
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (!hosts.has(req.headers.host || "")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"error":"forbidden host"}');
      return;
    }

    if (authToken) {
      const p = url.pathname;
      const guarded = p === "/poll" || p === "/submit" || p.startsWith("/result/");
      if (guarded && req.headers["x-mcp-token"] !== authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/poll") {
      lastPollAt = Date.now();
      if (pending.length > 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pending.shift()));
        return;
      }
      let sent = false;
      const timer = setTimeout(() => {
        if (sent) return;
        sent = true;
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, pollTimeoutMs);
      const waiter = (cmd) => {
        if (sent) return;
        sent = true;
        clearTimeout(timer);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cmd));
      };
      waiters.push(waiter);
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
      });
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
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queued: pending.length, inFlight: inFlight.size }));
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

  httpServer.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`${brandPrefix} FATAL: ${host}:${port} is already in use — another server is bound to it. Close it and retry.`);
    } else {
      console.error(`${brandPrefix} FATAL: HTTP server error: ${err.message}`);
    }
    process.exit(1);
  });

  httpServer.listen(port, host, () => {
    if (!allowedHosts && port === 0) {
      const real = httpServer.address().port; // ephemeral: rebuild allowlist with the assigned port
      hosts = new Set([`${host}:${real}`, `localhost:${real}`]);
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
