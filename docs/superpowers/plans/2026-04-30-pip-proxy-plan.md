# pip-proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready HTTP forward proxy with CONNECT tunneling, Basic Auth, and zero-buffering stream piping, deployed to Railway via GitHub Actions.

**Architecture:** Single-file Node.js server using built-in `http` and `net` modules. Two event handlers on one server: `'connect'` for HTTPS tunneling, `'request'` for HTTP proxy + health check. Integration tests using `node:test`. CI/CD via GitHub Actions → Railway CLI.

**Tech Stack:** Node.js 20, TypeScript, `node:test`, GitHub Actions, Railway, Docker

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.dockerignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "pip-proxy",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "tsx --test test/proxy.test.ts"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
.env
```

- [ ] **Step 4: Create .dockerignore**

```
node_modules/
dist/
.git/
.env
*.md
test/
docs/
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .dockerignore
git commit -m "chore: scaffold project with typescript and tsx"
```

---

## Task 2: Health Check Endpoint (TDD)

**Files:**
- Create: `test/proxy.test.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `test/proxy.test.ts`:

```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PROXY_PORT = 0; // OS assigns free port
let proxyUrl: string;
let proxyProcess: { close: () => Promise<void> };

async function startProxy(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const { createProxyServer } = await import('../src/index.js');
  const server = createProxyServer();
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address() as import('node:net').AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Health Check', () => {
  before(async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    const result = await startProxy(PROXY_PORT);
    proxyUrl = result.url;
    proxyProcess = result;
  });

  after(async () => {
    await proxyProcess.close();
  });

  it('returns 200 OK on GET /health without auth', async () => {
    const res = await fetch(`${proxyUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/proxy.test.ts`
Expected: FAIL — `../src/index.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/index.ts`:

```typescript
import http from 'node:http';

const PORT = parseInt(process.env.PORT || '3128', 10);

export function createProxyServer(): http.Server {
  const server = http.createServer((req, res) => {
    // Health check — not a proxy request
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/proxy.test.ts`
Expected: PASS — `Health Check > returns 200 OK on GET /health without auth`

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/proxy.test.ts
git commit -m "feat: add health check endpoint with integration test"
```

---

## Task 3: Basic Auth (TDD)

**Files:**
- Modify: `src/index.ts`
- Modify: `test/proxy.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/proxy.test.ts`:

```typescript
describe('Authentication', () => {
  before(async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    const result = await startProxy(PROXY_PORT);
    proxyUrl = result.url;
    proxyProcess = result;
  });

  after(async () => {
    await proxyProcess.close();
  });

  it('returns 407 when no Proxy-Authorization header is sent', async () => {
    // Send a proxy-style request (absolute URI)
    const res = await fetch(`${proxyUrl}/`, {
      headers: { Host: 'example.com' },
    });
    // Non-health, non-proxy request without auth → 407
    assert.equal(res.status, 407);
    assert.ok(res.headers.get('proxy-authenticate')?.includes('Basic'));
  });

  it('returns 407 when wrong credentials are sent', async () => {
    const badCreds = Buffer.from('wrong:creds').toString('base64');
    const res = await fetch(`${proxyUrl}/`, {
      headers: {
        'Proxy-Authorization': `Basic ${badCreds}`,
      },
    });
    assert.equal(res.status, 407);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/proxy.test.ts`
Expected: FAIL — the server returns `400`, not `407`.

- [ ] **Step 3: Implement auth validation**

Add to `src/index.ts`, before the `createProxyServer` function:

```typescript
import crypto from 'node:crypto';

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
```

Update the request handler in `createProxyServer`:

```typescript
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (!authenticate(req)) {
    send407(res);
    return;
  }

  // Proxy logic placeholder
  res.writeHead(400);
  res.end('Bad Request');
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/proxy.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/proxy.test.ts
git commit -m "feat: add basic auth with timing-safe comparison"
```

---

## Task 4: SSRF Protection (TDD)

**Files:**
- Modify: `src/index.ts`
- Modify: `test/proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.test.ts`:

```typescript
describe('SSRF Protection', () => {
  before(async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    const result = await startProxy(PROXY_PORT);
    proxyUrl = result.url;
    proxyProcess = result;
  });

  after(async () => {
    await proxyProcess.close();
  });

  it('returns 403 when CONNECT targets a private IP', (_, done) => {
    const creds = Buffer.from('testuser:testpass').toString('base64');
    const req = http.request({
      host: new URL(proxyUrl).hostname,
      port: new URL(proxyUrl).port,
      method: 'CONNECT',
      path: '127.0.0.1:443',
      headers: { 'Proxy-Authorization': `Basic ${creds}` },
    });
    req.on('response', (res) => {
      assert.equal(res.statusCode, 403);
      done();
    });
    req.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/proxy.test.ts`
Expected: FAIL — no `'connect'` handler exists yet.

- [ ] **Step 3: Implement SSRF check and stub CONNECT handler**

Add to `src/index.ts`:

```typescript
import net from 'node:net';
import dns from 'node:dns/promises';

function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 127) return true;                              // 127.0.0.0/8
    if (parts[0] === 10) return true;                               // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;         // 192.168.0.0/16
    if (parts[0] === 0) return true;                                // 0.0.0.0/8
    if (parts[0] === 169 && parts[1] === 254) return true;         // 169.254.0.0/16
  }
  // IPv6 private
  if (ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;      // fc00::/7
  return false;
}

async function resolveAndCheckSSRF(hostname: string): Promise<string> {
  // If hostname is already an IP, check directly
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error('SSRF');
    return hostname;
  }
  const { address } = await dns.lookup(hostname);
  if (isPrivateIP(address)) throw new Error('SSRF');
  return address;
}
```

Add the CONNECT handler inside `createProxyServer`, after `const server = ...`:

```typescript
server.on('connect', async (req, clientSocket, head) => {
  const start = Date.now();

  if (!authenticate(req)) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="pip-proxy"\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  const [hostname, portStr] = (req.url || '').split(':');
  const port = parseInt(portStr || '443', 10);

  let resolvedIP: string;
  try {
    resolvedIP = await resolveAndCheckSSRF(hostname);
  } catch {
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
    log({ method: 'CONNECT', target: req.url || '', status: 403, duration_ms: Date.now() - start });
    return;
  }

  // Tunnel establishment will be implemented in Task 5
  clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  clientSocket.destroy();
});
```

Add a logging helper:

```typescript
function log(entry: { method: string; target: string; status: number; duration_ms: number }): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/proxy.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/proxy.test.ts
git commit -m "feat: add SSRF protection with private IP detection"
```

---

## Task 5: CONNECT Tunneling (TDD)

**Files:**
- Modify: `src/index.ts`
- Modify: `test/proxy.test.ts`

- [ ] **Step 1: Write the failing test**

To test CONNECT tunneling, we need a target server. Append to `test/proxy.test.ts`:

```typescript
describe('CONNECT Tunneling', () => {
  let targetServer: http.Server;
  let targetPort: number;

  before(async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';

    // Start a simple TCP echo server as the tunnel target
    targetServer = net.createServer((socket) => {
      socket.on('data', (data) => {
        socket.write(`echo:${data.toString()}`);
      });
    }) as unknown as http.Server;
    await new Promise<void>((resolve) => (targetServer as unknown as net.Server).listen(0, '127.0.0.1', resolve));
    targetPort = ((targetServer as unknown as net.Server).address() as net.AddressInfo).port;

    const result = await startProxy(PROXY_PORT);
    proxyUrl = result.url;
    proxyProcess = result;
  });

  after(async () => {
    await proxyProcess.close();
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  it('establishes tunnel and pipes data bidirectionally', (_, done) => {
    const creds = Buffer.from('testuser:testpass').toString('base64');
    const proxyUrlObj = new URL(proxyUrl);
    const req = http.request({
      host: proxyUrlObj.hostname,
      port: proxyUrlObj.port,
      method: 'CONNECT',
      path: `127.0.0.1:${targetPort}`,
      headers: { 'Proxy-Authorization': `Basic ${creds}` },
    });

    req.on('connect', (_res, socket) => {
      assert.ok(socket);
      socket.write('hello');
      socket.on('data', (data) => {
        assert.equal(data.toString(), 'echo:hello');
        socket.destroy();
        done();
      });
    });
    req.end();
  });
});
```

Add `net` to the imports at the top of the test file:

```typescript
import net from 'node:net';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/proxy.test.ts`
Expected: FAIL — the CONNECT handler returns `502` (stub from Task 4) or the SSRF check blocks `127.0.0.1`.

- [ ] **Step 3: Implement CONNECT tunneling**

**Important:** The test connects to `127.0.0.1` which is a private IP. We need to make SSRF configurable for testing. Update `createProxyServer` to accept options:

```typescript
interface ProxyOptions {
  disableSSRF?: boolean; // Only for testing
}

export function createProxyServer(options: ProxyOptions = {}): http.Server {
```

Update the CONNECT handler — replace the stub `502` section with the real tunnel:

```typescript
server.on('connect', async (req, clientSocket, head) => {
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
```

Update `startProxy` in the test file to pass `disableSSRF`:

```typescript
async function startProxy(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const { createProxyServer } = await import('../src/index.js');
  const server = createProxyServer({ disableSSRF: true });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address() as import('node:net').AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

And create a separate `startProxy` for the SSRF test (without `disableSSRF`):

```typescript
async function startProxyStrict(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const { createProxyServer } = await import('../src/index.js');
  const server = createProxyServer();
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address() as import('node:net').AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

Update the SSRF test to use `startProxyStrict`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/proxy.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/proxy.test.ts
git commit -m "feat: implement CONNECT tunneling with bidirectional piping"
```

---

## Task 6: HTTP Forward Proxy (TDD)

**Files:**
- Modify: `src/index.ts`
- Modify: `test/proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.test.ts`:

```typescript
describe('HTTP Forward Proxy', () => {
  let targetServer: http.Server;
  let targetPort: number;

  before(async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';

    // Simple HTTP server that echoes back
    targetServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Test': 'forwarded' });
      res.end(`received:${req.url}`);
    });
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    targetPort = (targetServer.address() as net.AddressInfo).port;

    const result = await startProxy(PROXY_PORT);
    proxyUrl = result.url;
    proxyProcess = result;
  });

  after(async () => {
    await proxyProcess.close();
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  it('forwards HTTP request and streams response back', async () => {
    const creds = Buffer.from('testuser:testpass').toString('base64');
    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request({
        host: new URL(proxyUrl).hostname,
        port: new URL(proxyUrl).port,
        method: 'GET',
        path: `http://127.0.0.1:${targetPort}/test-path`,
        headers: { 'Proxy-Authorization': `Basic ${creds}` },
      }, resolve);
      req.end();
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-test'], 'forwarded');

    const body = await new Promise<string>((resolve) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    assert.equal(body, 'received:/test-path');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/proxy.test.ts`
Expected: FAIL — the request handler returns `400` for proxy requests.

- [ ] **Step 3: Implement HTTP forward proxy**

Update the request handler in `createProxyServer`:

```typescript
const server = http.createServer(async (req, res) => {
  const start = Date.now();

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Auth check
  if (!authenticate(req)) {
    send407(res);
    return;
  }

  // HTTP forward proxy — detect by absolute URI
  if (req.url && req.url.startsWith('http://')) {
    const targetUrl = new URL(req.url);

    if (!options.disableSSRF) {
      try {
        await resolveAndCheckSSRF(targetUrl.hostname);
      } catch {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        log({ method: req.method || 'GET', target: targetUrl.host, status: 403, duration_ms: Date.now() - start });
        return;
      }
    }

    const proxyReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.host,
          'proxy-authorization': undefined, // Strip proxy auth from forwarded request
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
        log({ method: req.method || 'GET', target: targetUrl.host, status: proxyRes.statusCode || 502, duration_ms: Date.now() - start });
      },
    );

    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
      log({ method: req.method || 'GET', target: targetUrl.host, status: 502, duration_ms: Date.now() - start });
    });

    proxyReq.setTimeout(30_000, () => {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Gateway Timeout');
      proxyReq.destroy();
      log({ method: req.method || 'GET', target: targetUrl.host, status: 504, duration_ms: Date.now() - start });
    });

    req.pipe(proxyReq);
    return;
  }

  // Not a proxy request and not health check
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('Bad Request');
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/proxy.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/proxy.test.ts
git commit -m "feat: implement HTTP forward proxy with stream piping"
```

---

## Task 7: Graceful Shutdown (TDD)

**Files:**
- Modify: `src/index.ts`
- Modify: `test/proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.test.ts`:

```typescript
describe('Graceful Shutdown', () => {
  it('stops accepting new connections after close is called', async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    const result = await startProxy(PROXY_PORT);

    // Verify server is running
    const res = await fetch(`${result.url}/health`);
    assert.equal(res.status, 200);

    // Close the server
    await result.close();

    // Verify server is no longer accepting connections
    await assert.rejects(
      () => fetch(`${result.url}/health`),
      (err: Error) => err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

This test should already pass since `server.close()` is implemented in the test helper. The key addition is the production-side shutdown handler.

Run: `npx tsx --test test/proxy.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 3: Add SIGTERM handler to production entry point**

Update the `isMainModule` block in `src/index.ts`:

```typescript
if (isMainModule) {
  const server = createProxyServer();
  server.listen(PORT, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `proxy listening on port ${PORT}` }));
  });

  const shutdown = () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'shutting down...' }));
    server.close(() => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'all connections drained, exiting' }));
      process.exit(0);
    });

    // Force exit after 10s grace period
    setTimeout(() => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'grace period expired, forcing exit' }));
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
```

- [ ] **Step 4: Run all tests**

Run: `npx tsx --test test/proxy.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/proxy.test.ts
git commit -m "feat: add graceful shutdown with 10s drain period"
```

---

## Task 8: Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create multi-stage Dockerfile**

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3128

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Test Docker build locally**

Run: `docker build -t pip-proxy .`
Expected: Build succeeds. Image should be ~60-80MB.

- [ ] **Step 3: Test Docker run locally**

Run: `docker run --rm -e PROXY_USERNAME=test -e PROXY_PASSWORD=test -p 3128:3128 pip-proxy`
Expected: Logs `proxy listening on port 3128`. `curl http://localhost:3128/health` returns `{"status":"ok"}`.

Stop with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "chore: add multi-stage Dockerfile for production"
```

---

## Task 9: GitHub Actions CI/CD

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create deploy workflow**

```yaml
name: Deploy pip-proxy to Railway

on:
  push:
    branches:
      - main

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Run tests
        env:
          PROXY_USERNAME: testuser
          PROXY_PASSWORD: testpass
        run: npm test

  deploy:
    needs: build-and-test
    runs-on: ubuntu-latest
    container: ghcr.io/railwayapp/cli:latest
    environment: production

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Deploy to Railway
        run: railway up --service=${{ vars.RAILWAY_SERVICE_ID }}
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_DEPLOYMENT_ACCESS_TOKEN }}
```

- [ ] **Step 2: Verify workflow syntax**

Run: `cat .github/workflows/deploy.yml | head -5`
Expected: File exists and starts with `name: Deploy pip-proxy to Railway`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add GitHub Actions workflow for build, test, and Railway deploy"
```

---

## Task 10: Final Integration Verification

**Files:**
- No new files — verification only.

- [ ] **Step 1: Run full test suite**

Run: `npx tsx --test test/proxy.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 2: Build TypeScript**

Run: `npm run build`
Expected: `dist/index.js` created with no errors.

- [ ] **Step 3: Start server and manually verify health**

Run: `PROXY_USERNAME=test PROXY_PASSWORD=test node dist/index.js &`
Run: `curl -s http://localhost:3128/health`
Expected: `{"status":"ok"}`

Run: `curl -s -x http://test:test@localhost:3128 http://httpbin.org/ip`
Expected: Response with the server's IP.

Run: `kill %1`

- [ ] **Step 4: Docker build**

Run: `docker build -t pip-proxy .`
Expected: Build succeeds.

- [ ] **Step 5: Final commit if any changes**

```bash
git status
# If clean, nothing to commit
```

---

## Setup Required in Railway & GitHub

After code is pushed:

1. **Railway:** Create a new project and service. Note the `RAILWAY_SERVICE_ID`.
2. **Railway:** Set environment variables: `PROXY_USERNAME`, `PROXY_PASSWORD`, `PORT=3128`.
3. **GitHub:** Add repository secret `RAILWAY_DEPLOYMENT_ACCESS_TOKEN`.
4. **GitHub:** Add repository variable `RAILWAY_SERVICE_ID`.
5. **Push to main** — CI/CD triggers automatically.
