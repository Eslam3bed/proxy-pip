import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const USER_AGENTS: string[] = require('./user-agents.json');

const PORT = parseInt(process.env.PORT || '3000', 10);

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }
  if (ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

async function resolveAndCheckSSRF(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error('SSRF');
    return;
  }
  const { address } = await dns.lookup(hostname);
  if (isPrivateIP(address)) throw new Error('SSRF');
}

function log(entry: { method: string; target: string; status: number; duration_ms: number }): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

interface RelayBody {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string; // base64-encoded
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

interface RelayOptions {
  disableSSRF?: boolean;
  connectTimeout?: number;
}

export function createRelayServer(options: RelayOptions = {}): http.Server {
  const server = http.createServer(async (req, res) => {
    const start = Date.now();

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Relay endpoint
    if (req.method === 'POST' && req.url === '/relay') {
      let parsed: RelayBody;
      try {
        const raw = await readBody(req);
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      if (!parsed.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      let targetUrl: URL;
      try {
        targetUrl = new URL(parsed.url);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      const targetHostname = targetUrl.hostname;

      // SSRF protection
      if (!options.disableSSRF) {
        try {
          await resolveAndCheckSSRF(targetHostname);
        } catch {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          log({ method: parsed.method || 'GET', target: targetHostname, status: 403, duration_ms: Date.now() - start });
          return;
        }
      }

      const reqHeaders: Record<string, string> = parsed.headers || {};
      if (!reqHeaders['user-agent'] && !reqHeaders['User-Agent']) {
        reqHeaders['User-Agent'] = randomUserAgent();
      }
      const bodyBuffer = parsed.body ? Buffer.from(parsed.body, 'base64') : null;

      const MAX_REDIRECTS = 5;

      function makeRequest(
        url: URL,
        method: string,
        headers: Record<string, string>,
        body: Buffer | null,
        redirectCount: number,
      ): void {
        if (redirectCount > MAX_REDIRECTS) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Too many redirects');
          log({ method, target: url.hostname, status: 502, duration_ms: Date.now() - start });
          return;
        }

        const isHttps = url.protocol === 'https:';
        const requestModule = isHttps ? https : http;
        const defaultPort = isHttps ? 443 : 80;

        const proxyReq = requestModule.request(
          {
            hostname: url.hostname,
            port: parseInt(url.port, 10) || defaultPort,
            path: url.pathname + url.search,
            method,
            headers,
          },
          (proxyRes) => {
            const status = proxyRes.statusCode || 502;

            // Follow redirects
            if (status >= 300 && status < 400 && proxyRes.headers.location) {
              proxyRes.resume();

              let redirectUrl: URL;
              try {
                redirectUrl = new URL(proxyRes.headers.location, url.href);
              } catch {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad redirect URL');
                log({ method, target: url.hostname, status: 502, duration_ms: Date.now() - start });
                return;
              }

              // SSRF check the redirect target
              if (!options.disableSSRF) {
                resolveAndCheckSSRF(redirectUrl.hostname).then(() => {
                  const redirectMethod = (status === 307 || status === 308) ? method : 'GET';
                  const redirectBody = (status === 307 || status === 308) ? body : null;
                  makeRequest(redirectUrl, redirectMethod, headers, redirectBody, redirectCount + 1);
                }).catch(() => {
                  res.writeHead(403, { 'Content-Type': 'text/plain' });
                  res.end('Forbidden');
                  log({ method, target: redirectUrl.hostname, status: 403, duration_ms: Date.now() - start });
                });
                return;
              }

              const redirectMethod = (status === 307 || status === 308) ? method : 'GET';
              const redirectBody = (status === 307 || status === 308) ? body : null;
              makeRequest(redirectUrl, redirectMethod, headers, redirectBody, redirectCount + 1);
              return;
            }

            // Normal response — pipe back
            const responseHeaders = proxyRes.headers as Record<string, string | string[] | undefined>;
            res.writeHead(200, {
              'X-Relay-Status': String(status),
              'X-Relay-Headers': JSON.stringify(responseHeaders),
              'Content-Type': 'application/octet-stream',
            });
            proxyRes.pipe(res);
            log({ method, target: url.hostname, status, duration_ms: Date.now() - start });
          },
        );

        proxyReq.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Bad Gateway');
          }
          log({ method, target: url.hostname, status: 502, duration_ms: Date.now() - start });
        });

        proxyReq.setTimeout(options.connectTimeout ?? 30_000, () => {
          if (!res.headersSent) {
            res.writeHead(504, { 'Content-Type': 'text/plain' });
            res.end('Gateway Timeout');
          }
          proxyReq.destroy();
          log({ method, target: url.hostname, status: 504, duration_ms: Date.now() - start });
        });

        if (body) {
          proxyReq.write(body);
        }
        proxyReq.end();
      }

      makeRequest(targetUrl, parsed.method || 'GET', reqHeaders, bodyBuffer, 0);
      return;
    }

    // Unknown route
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
  });

  return server;
}

// Start server when run directly
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  const server = createRelayServer();
  server.listen(PORT, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `relay listening on port ${PORT}`, port: PORT, endpoints: { health: '/health', relay: '/relay' } }));
  });

  const shutdown = () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'shutting down...' }));
    server.close(() => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'all connections drained, exiting' }));
      process.exit(0);
    });

    setTimeout(() => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'grace period expired, forcing exit' }));
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
