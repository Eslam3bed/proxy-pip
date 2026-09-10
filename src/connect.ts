import http from 'node:http';
import net from 'node:net';
import { KeyStore, AccessKey } from './keys.js';
import { resolveAndCheckSSRF } from './net-guard.js';

export interface ConnectProxyOptions {
  store: KeyStore;
  disableSSRF?: boolean;
  connectTimeout?: number;
  log?: (entry: Record<string, unknown>) => void;
}

function defaultLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

/**
 * Parse `Proxy-Authorization: Basic base64(keyId:secret)`.
 * Returns the matching access key, or null when absent/invalid.
 */
export function authenticateProxyRequest(
  header: string | undefined,
  store: KeyStore,
): AccessKey | null {
  if (!header?.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  const keyId = decoded.slice(0, separator);
  const secret = decoded.slice(separator + 1);
  return store.verifyPair(keyId, secret);
}

/**
 * A standard HTTP forward proxy: CONNECT for HTTPS, absolute-URI for plain HTTP.
 *
 * This listener is meant to be exposed through Railway's TCP Proxy, NOT the
 * HTTP edge — the edge intercepts CONNECT before the app ever sees it, which
 * is why the JSON /relay endpoint exists alongside this.
 */
export function createConnectProxy(options: ConnectProxyOptions): http.Server {
  const { store, disableSSRF = false, connectTimeout = 30_000 } = options;
  const log = options.log ?? defaultLog;

  const server = http.createServer((req, res) => {
    // Plain-HTTP forward proxying uses an absolute URI in the request line.
    const start = Date.now();
    const key = authenticateProxyRequest(req.headers['proxy-authorization'], store);
    if (!key) {
      res.writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="pip-proxy"',
        'Content-Type': 'text/plain',
      });
      res.end('Proxy Authentication Required');
      return;
    }

    let target: URL;
    try {
      target = new URL(req.url || '');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request — absolute URI required');
      return;
    }

    const forward = async () => {
      if (!disableSSRF) {
        try {
          await resolveAndCheckSSRF(target.hostname);
        } catch {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          log({ method: req.method, target: target.hostname, status: 403, key: key.id, duration_ms: Date.now() - start });
          return;
        }
      }

      const headers = { ...req.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];

      const upstream = http.request(
        {
          hostname: target.hostname,
          port: parseInt(target.port, 10) || 80,
          path: target.pathname + target.search,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
          log({ method: req.method, target: target.hostname, status: upstreamRes.statusCode, key: key.id, duration_ms: Date.now() - start });
        },
      );

      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway');
        }
        log({ method: req.method, target: target.hostname, status: 502, key: key.id, duration_ms: Date.now() - start });
      });

      req.pipe(upstream);
    };

    void forward();
  });

  // CONNECT is the path yt-dlp takes for every https:// URL.
  server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const start = Date.now();

    const refuse = (status: number, message: string, extraHeader = '') => {
      clientSocket.write(`HTTP/1.1 ${status} ${message}\r\n${extraHeader}\r\n`);
      clientSocket.end();
    };

    const key = authenticateProxyRequest(req.headers['proxy-authorization'], store);
    if (!key) {
      refuse(407, 'Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="pip-proxy"\r\n');
      log({ method: 'CONNECT', target: req.url, status: 407, duration_ms: Date.now() - start });
      return;
    }

    const [hostname, rawPort] = (req.url || '').split(':');
    const port = parseInt(rawPort, 10) || 443;
    if (!hostname) {
      refuse(400, 'Bad Request');
      return;
    }

    const open = async () => {
      if (!disableSSRF) {
        try {
          await resolveAndCheckSSRF(hostname);
        } catch {
          refuse(403, 'Forbidden');
          log({ method: 'CONNECT', target: hostname, status: 403, key: key.id, duration_ms: Date.now() - start });
          return;
        }
      }

      const upstream = net.connect({ host: hostname, port });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        upstream.destroy();
        refuse(504, 'Gateway Timeout');
        log({ method: 'CONNECT', target: hostname, status: 504, key: key.id, duration_ms: Date.now() - start });
      }, connectTimeout);

      upstream.on('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        // No timeout past this point — video downloads legitimately run long.
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        log({ method: 'CONNECT', target: hostname, status: 200, key: key.id, duration_ms: Date.now() - start });
      });

      upstream.on('error', () => {
        if (settled) {
          clientSocket.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        refuse(502, 'Bad Gateway');
        log({ method: 'CONNECT', target: hostname, status: 502, key: key.id, duration_ms: Date.now() - start });
      });

      clientSocket.on('error', () => upstream.destroy());
    };

    void open();
  });

  return server;
}
