import http from 'node:http';
import https from 'node:https';
import { KeyStore, AccessKey, resolveDataDir } from './keys.js';
import { handleSettings, SettingsConfig } from './settings.js';
import { createConnectProxy } from './connect.js';
import { resolveAndCheckSSRF } from './net-guard.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const TCP_PORT = parseInt(process.env.TCP_PORT || '3129', 10);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function log(entry: Record<string, unknown>): void {
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

export interface RelayOptions {
  disableSSRF?: boolean;
  connectTimeout?: number;
  store?: KeyStore;
  settings?: SettingsConfig;
  /**
   * Keeps /relay open to unauthenticated callers. Defaults to true so that
   * deploying key support does not instantly break already-running clients;
   * set ALLOW_UNAUTHENTICATED_RELAY=false once every caller sends a secret.
   */
  allowUnauthenticated?: boolean;
}

/** Extract a relay secret from either supported header form. */
function extractSecret(req: http.IncomingMessage): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const custom = req.headers['x-relay-secret'];
  if (typeof custom === 'string') return custom.trim();
  return '';
}

let cachedExitIp: { value: string; at: number } | null = null;

async function getExitIp(): Promise<string | null> {
  if (cachedExitIp && Date.now() - cachedExitIp.at < 300_000) return cachedExitIp.value;
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json()) as { ip?: string };
    if (!data.ip) return null;
    cachedExitIp = { value: data.ip, at: Date.now() };
    return data.ip;
  } catch {
    return null;
  }
}

export function createRelayServer(options: RelayOptions = {}): http.Server {
  const store = options.store ?? new KeyStore(null);
  const allowUnauthenticated = options.allowUnauthenticated ?? true;
  const settings = options.settings;

  const server = http.createServer(async (req, res) => {
    const start = Date.now();

    // Health check — deliberately unauthenticated, used by Railway + uptime checks.
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (settings && (await handleSettings(req, res, store, settings))) return;

    // Authenticated status probe — this is what an engine calls to render
    // "proxy: connected" and to prove which IP its traffic egresses from.
    if (req.method === 'GET' && req.url === '/v1/verify') {
      const secret = extractSecret(req);
      const key: AccessKey | null = secret ? store.verifySecret(secret) : null;
      if (!key) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid or missing access secret' }));
        return;
      }
      const exitIp = await getExitIp();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        keyId: key.id,
        name: key.name,
        createdAt: key.createdAt,
        exitIp,
        tcpProxyConfigured: Boolean(settings?.publicTcpHost && settings?.publicTcpPort),
      }));
      return;
    }

    // Relay endpoint
    if (req.method === 'POST' && req.url === '/relay') {
      const secret = extractSecret(req);
      const key = secret ? store.verifySecret(secret) : null;

      if (!key && !allowUnauthenticated) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        log({ method: 'POST', target: '/relay', status: 401, duration_ms: Date.now() - start });
        return;
      }

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
            log({ method, target: url.hostname, status, key: key?.id, duration_ms: Date.now() - start });
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
  const dataDir = resolveDataDir(process.env.DATA_DIR || '/data');
  const store = new KeyStore(dataDir);

  const settings: SettingsConfig = {
    adminPassword: process.env.ADMIN_PASSWORD || null,
    publicRelayUrl: process.env.PUBLIC_RELAY_URL || `http://localhost:${PORT}`,
    publicTcpHost: process.env.PUBLIC_TCP_HOST || null,
    publicTcpPort: process.env.PUBLIC_TCP_PORT || null,
  };

  const allowUnauthenticated = process.env.ALLOW_UNAUTHENTICATED_RELAY !== 'false';

  if (!dataDir) {
    log({ level: 'warn', msg: 'DATA_DIR is not writable — access keys are memory-only and will be lost on redeploy. Attach a Railway volume.' });
  }
  if (!settings.adminPassword) {
    log({ level: 'warn', msg: 'ADMIN_PASSWORD is not set — /settings is disabled.' });
  }
  if (allowUnauthenticated) {
    log({ level: 'warn', msg: '/relay accepts unauthenticated requests. Set ALLOW_UNAUTHENTICATED_RELAY=false once every client sends a secret.' });
  }

  const server = createRelayServer({ store, settings, allowUnauthenticated });
  server.listen(PORT, () => {
    log({
      msg: `relay listening on port ${PORT}`,
      port: PORT,
      endpoints: { health: '/health', relay: '/relay', verify: '/v1/verify', settings: '/settings' },
      activeKeys: store.count,
      persistentKeys: store.persistent,
    });
  });

  const connectProxy = createConnectProxy({ store, log });
  connectProxy.listen(TCP_PORT, () => {
    log({ msg: `connect proxy listening on port ${TCP_PORT}`, port: TCP_PORT });
  });

  const shutdown = () => {
    log({ msg: 'shutting down...' });
    let remaining = 2;
    const done = () => {
      remaining -= 1;
      if (remaining === 0) {
        log({ msg: 'all connections drained, exiting' });
        process.exit(0);
      }
    };
    server.close(done);
    connectProxy.close(done);

    setTimeout(() => {
      log({ msg: 'grace period expired, forcing exit' });
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
