import http from 'node:http';
import net from 'node:net';
import { KeyStore, AccessKey } from './keys.js';
import { resolveAndCheckSSRF } from './net-guard.js';

export interface ConnectProxyOptions {
  store: KeyStore;
  disableSSRF?: boolean;
  connectTimeout?: number;
  log?: (entry: Record<string, unknown>) => void;
  /**
   * An upstream HTTP proxy to chain through, as a URL:
   * `http://user:pass@host:port`. When set, every tunnel is opened by sending
   * CONNECT to the upstream instead of dialling the target, so the exit
   * address YouTube sees is the upstream's, not this host's. Unset means
   * direct egress from this process, the original behaviour.
   */
  upstream?: string;
}

interface Upstream {
  host: string;
  port: number;
  auth: string | null; // base64(user:pass), or null
  label: string;       // host:port, safe to log
}

export function parseUpstream(url: string | undefined | null): Upstream | null {
  if (!url) return null;
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new Error(`UPSTREAM_PROXY must be an http:// URL, got ${u.protocol}`);
  const auth = u.username
    ? Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
    : null;
  return { host: u.hostname, port: parseInt(u.port, 10) || 80, auth, label: `${u.hostname}:${u.port || 80}` };
}

/**
 * Open a tunnel to `hostname:port` through the upstream proxy. Resolves with
 * the connected socket plus any bytes the upstream sent after its response
 * headers, which belong to the target and must be forwarded to the client.
 */
function connectViaUpstream(
  up: Upstream,
  hostname: string,
  port: number,
  timeoutMs: number,
): Promise<{ socket: net.Socket; leftover: Buffer; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: up.host, port: up.port });
    let buffered = Buffer.alloc(0);
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('upstream connect timeout')), timeoutMs);
    socket.once('error', fail);
    socket.once('connect', () => {
      const authLine = up.auth ? `Proxy-Authorization: Basic ${up.auth}\r\n` : '';
      socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n${authLine}\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (done) return;
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.removeListener('error', fail);
      const head = buffered.subarray(0, end).toString('latin1');
      const status = parseInt(head.split(' ')[1] || '0', 10);
      if (status !== 200) {
        socket.destroy();
        const err = new Error(`upstream answered ${status}`) as Error & { status: number };
        err.status = status;
        reject(err);
        return;
      }
      resolve({ socket, leftover: buffered.subarray(end + 4), status });
    });
  });
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
  const up = parseUpstream(options.upstream);
  const via = up ? up.label : 'direct';

  const server = http.createServer((req, res) => {
    // Plain-HTTP forward proxying uses an absolute URI in the request line.
    const start = Date.now();

    // Diagnose the wiring before asking for credentials. A forward-proxy
    // client always sends an absolute URI; a relative path means something is
    // routing ordinary HTTP traffic here — usually a public domain pointed at
    // this port instead of the relay's. Answering 407 in that case sends the
    // operator hunting for a credential bug that does not exist.
    let target: URL;
    try {
      target = new URL(req.url || '');
      if (!target.protocol.startsWith('http')) throw new Error('not http');
    } catch {
      res.writeHead(421, { 'Content-Type': 'text/plain' });
      res.end(
        'This is the CONNECT forward-proxy port, reached via Railway TCP Proxy.\n' +
        'It only serves absolute-URI proxy requests.\n' +
        'The HTTP API (/health, /relay, /v1/verify, /settings) is on PORT.\n' +
        'If you see this from a browser, a public domain is pointed at the wrong port.\n',
      );
      return;
    }

    const key = authenticateProxyRequest(req.headers['proxy-authorization'], store);
    if (!key) {
      res.writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="pip-proxy"',
        'Content-Type': 'text/plain',
      });
      res.end('Proxy Authentication Required');
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
        up
          ? {
              // An upstream forward proxy takes the absolute URI on the
              // request line and its own credentials, same as we do.
              hostname: up.host,
              port: up.port,
              path: target.href,
              method: req.method,
              headers: up.auth ? { ...headers, 'proxy-authorization': `Basic ${up.auth}` } : headers,
            }
          : {
              hostname: target.hostname,
              port: parseInt(target.port, 10) || 80,
              path: target.pathname + target.search,
              method: req.method,
              headers,
            },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
          log({ method: req.method, target: target.hostname, status: upstreamRes.statusCode, key: key.id, via, duration_ms: Date.now() - start });
        },
      );

      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway');
        }
        log({ method: req.method, target: target.hostname, status: 502, key: key.id, duration_ms: Date.now() - start });
      });

      // Same reasoning as the CONNECT path: a client that goes away must not
      // strand the upstream request.
      res.on('close', () => upstream.destroy());

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

      // One place records the outcome of every tunnel: how it was opened,
      // how long it lived, how much moved each way, and who hung up. This is
      // what tells a throttled exit apart from a dead tunnel from the logs
      // alone: a 429 from YouTube is a short tunnel with a few KB down,
      // a dead exit is a 502 or 504 with nothing.
      const attach = (upstream: net.Socket, leftover: Buffer) => {
        let bytesUp = 0;
        let bytesDown = 0;
        const opened = Date.now();
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        if (leftover.length) { clientSocket.write(leftover); bytesDown += leftover.length; }
        upstream.on('data', (c: Buffer) => { bytesDown += c.length; });
        clientSocket.on('data', (c: Buffer) => { bytesUp += c.length; });
        // No timeout past this point — video downloads legitimately run long.
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        log({ method: 'CONNECT', target: hostname, status: 200, key: key.id, via, duration_ms: Date.now() - start });

        let closed = false;
        const finish = (closedBy: 'client' | 'upstream') => {
          if (closed) return;
          closed = true;
          log({
            event: 'tunnel_close', target: hostname, key: key.id, via, closed_by: closedBy,
            bytes_up: bytesUp, bytes_down: bytesDown, duration_ms: Date.now() - opened,
          });
        };
        // Tear the pair down together. A client that disconnects cleanly emits
        // 'close' rather than 'error', so listening only for 'error' leaks the
        // upstream socket — one per tunnel, and enough to stop a server from
        // ever draining on close().
        clientSocket.on('error', () => upstream.destroy());
        clientSocket.on('close', () => { finish('client'); upstream.destroy(); });
        upstream.on('close', () => { finish('upstream'); clientSocket.destroy(); });
      };

      if (up) {
        try {
          const { socket, leftover } = await connectViaUpstream(up, hostname, port, connectTimeout);
          attach(socket, leftover);
        } catch (err) {
          const status = (err as { status?: number }).status;
          const code = status === 407 ? 502 : status && status >= 400 ? 502 : /timeout/.test(String(err)) ? 504 : 502;
          refuse(code, code === 504 ? 'Gateway Timeout' : 'Bad Gateway');
          log({ method: 'CONNECT', target: hostname, status: code, key: key.id, via, upstream_status: status ?? null, duration_ms: Date.now() - start });
        }
        return;
      }

      const upstream = net.connect({ host: hostname, port });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        upstream.destroy();
        refuse(504, 'Gateway Timeout');
        log({ method: 'CONNECT', target: hostname, status: 504, key: key.id, via, duration_ms: Date.now() - start });
      }, connectTimeout);

      upstream.on('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        attach(upstream, Buffer.alloc(0));
      });

      upstream.on('error', () => {
        if (settled) {
          clientSocket.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        refuse(502, 'Bad Gateway');
        log({ method: 'CONNECT', target: hostname, status: 502, key: key.id, via, duration_ms: Date.now() - start });
      });
    };

    void open();
  });

  return server;
}
