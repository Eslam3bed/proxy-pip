import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';

const PORT = parseInt(process.env.PORT || '3128', 10);

function authenticate(req: http.IncomingMessage): boolean {
  const username = process.env.PROXY_USERNAME;
  const password = process.env.PROXY_PASSWORD;
  if (!username || !password) return false;

  const authHeader = req.headers['proxy-authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
  const colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) return false;

  const providedUser = decoded.slice(0, colonIndex);
  const providedPass = decoded.slice(colonIndex + 1);

  const userBuf = Buffer.from(providedUser);
  const passBuf = Buffer.from(providedPass);
  const expectedUserBuf = Buffer.from(username);
  const expectedPassBuf = Buffer.from(password);

  const userMatch =
    userBuf.length === expectedUserBuf.length &&
    crypto.timingSafeEqual(userBuf, expectedUserBuf);
  const passMatch =
    passBuf.length === expectedPassBuf.length &&
    crypto.timingSafeEqual(passBuf, expectedPassBuf);

  return userMatch && passMatch;
}

function send407(res: http.ServerResponse): void {
  res.writeHead(407, {
    'Proxy-Authenticate': 'Basic realm="pip-proxy"',
    'Content-Type': 'text/plain',
  });
  res.end('Proxy Authentication Required');
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

async function resolveAndCheckSSRF(hostname: string): Promise<string> {
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error('SSRF');
    return hostname;
  }
  const { address } = await dns.lookup(hostname);
  if (isPrivateIP(address)) throw new Error('SSRF');
  return address;
}

function log(entry: { method: string; target: string; status: number; duration_ms: number }): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

interface ProxyOptions {
  disableSSRF?: boolean;
}

export function createProxyServer(options: ProxyOptions = {}): http.Server {
  const server = http.createServer((req, res) => {
    // Health check — not a proxy request
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (!authenticate(req)) {
      send407(res);
      return;
    }

    // Placeholder — will be filled in later tasks
    res.writeHead(400);
    res.end('Bad Request');
  });

  server.on('connect', async (req: http.IncomingMessage, clientSocket: import('node:stream').Duplex, head: Buffer) => {
    const start = Date.now();

    if (!authenticate(req)) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="pip-proxy"\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const [hostname, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr || '443', 10);

    if (!options.disableSSRF) {
      try {
        await resolveAndCheckSSRF(hostname);
      } catch {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        log({ method: 'CONNECT', target: req.url || '', status: 403, duration_ms: Date.now() - start });
        return;
      }
    }

    const targetSocket = net.connect({ host: hostname, port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      targetSocket.setNoDelay(true);
      clientSocket.setNoDelay(true);

      if (head.length > 0) {
        targetSocket.write(head);
      }

      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);

      log({ method: 'CONNECT', target: req.url || '', status: 200, duration_ms: Date.now() - start });
    });

    targetSocket.setTimeout(30_000, () => {
      clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      targetSocket.destroy();
      clientSocket.destroy();
      log({ method: 'CONNECT', target: req.url || '', status: 504, duration_ms: Date.now() - start });
    });

    targetSocket.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      log({ method: 'CONNECT', target: req.url || '', status: 502, duration_ms: Date.now() - start });
    });

    clientSocket.on('error', () => {
      targetSocket.destroy();
    });
  });

  return server;
}

// Start server when run directly (not imported by tests)
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  const server = createProxyServer();
  server.listen(PORT, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `proxy listening on port ${PORT}` }));
  });
}
