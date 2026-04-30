import http from 'node:http';
import crypto from 'node:crypto';

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

export function createProxyServer(): http.Server {
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
