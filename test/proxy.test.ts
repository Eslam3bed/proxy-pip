import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execSync } from 'node:child_process';

const RELAY_PORT = 0; // OS assigns free port
let relayUrl: string;
let relayProcess: { close: () => Promise<void> };

async function startRelay(port: number, opts: { disableSSRF?: boolean; connectTimeout?: number } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const { createRelayServer } = await import('../src/index.js');
  const server = createRelayServer(opts);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function postRelay(baseUrl: string, body: object): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: '/relay',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
          body: data,
        });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('Health Check', () => {
  before(async () => {
    const result = await startRelay(RELAY_PORT, { disableSSRF: true });
    relayUrl = result.url;
    relayProcess = result;
  });

  after(async () => {
    await relayProcess.close();
  });

  it('returns 200 OK on GET /health', async () => {
    const res = await fetch(`${relayUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'ok');
  });
});

describe('Relay Endpoint', () => {
  let targetServer: http.Server;
  let targetPort: number;

  before(async () => {
    // Target HTTP server that the relay will fetch from
    targetServer = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Echo': 'true' });
          res.end(`post-body:${body}`);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Test': 'relayed' });
      res.end(`received:${req.url}`);
    });
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    targetPort = (targetServer.address() as net.AddressInfo).port;

    const result = await startRelay(RELAY_PORT, { disableSSRF: true });
    relayUrl = result.url;
    relayProcess = result;
  });

  after(async () => {
    await relayProcess.close();
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  it('returns 400 when url is missing', async () => {
    const res = await postRelay(relayUrl, { method: 'GET' });
    assert.equal(res.status, 400);
  });

  it('returns 400 for invalid URL in body', async () => {
    const res = await postRelay(relayUrl, { url: 'not-a-url', method: 'GET' });
    assert.equal(res.status, 400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const parsed = new URL(relayUrl);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: '/relay',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      });
      req.on('error', reject);
      req.write('not-json!!!');
      req.end();
    });
    assert.equal(result.status, 400);
  });

  it('relays GET request and returns target response via headers', async () => {
    const res = await postRelay(relayUrl, {
      url: `http://127.0.0.1:${targetPort}/test-path`,
      method: 'GET',
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-relay-status'], '200');

    const targetHeaders = JSON.parse(res.headers['x-relay-headers']);
    assert.equal(targetHeaders['x-test'], 'relayed');

    assert.equal(res.body, 'received:/test-path');
  });

  it('relays POST request with base64-encoded body', async () => {
    const bodyContent = 'hello relay';
    const res = await postRelay(relayUrl, {
      url: `http://127.0.0.1:${targetPort}/post-endpoint`,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from(bodyContent).toString('base64'),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-relay-status'], '200');
    assert.equal(res.body, `post-body:${bodyContent}`);
  });

  it('relays custom headers to the target', async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    const headerServer = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => headerServer.listen(0, '127.0.0.1', resolve));
    const headerPort = (headerServer.address() as net.AddressInfo).port;

    const res = await postRelay(relayUrl, {
      url: `http://127.0.0.1:${headerPort}/`,
      method: 'GET',
      headers: { 'X-Custom': 'my-value', 'Accept': 'text/html' },
    });

    assert.equal(res.status, 200);
    assert.equal(capturedHeaders['x-custom'], 'my-value');
    assert.equal(capturedHeaders['accept'], 'text/html');

    await new Promise<void>((resolve) => headerServer.close(() => resolve()));
  });
});

describe('HTTPS Target', () => {
  let httpsServer: https.Server;
  let httpsPort: number;

  before(async () => {
    // Generate self-signed cert via openssl
    const certOut = execSync(
      'openssl req -x509 -newkey rsa:2048 -keyout /dev/stdout -out /dev/stdout -days 1 -nodes -subj "/CN=localhost" 2>/dev/null',
      { encoding: 'utf-8' },
    );
    const keyMatch = certOut.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/);
    const certMatch = certOut.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (!keyMatch || !certMatch) throw new Error('Failed to generate self-signed cert');

    httpsServer = https.createServer({ key: keyMatch[0], cert: certMatch[0] }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Secure': 'yes' });
      res.end('https-ok');
    });
    await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
    httpsPort = (httpsServer.address() as net.AddressInfo).port;

    const result = await startRelay(RELAY_PORT, { disableSSRF: true });
    relayUrl = result.url;
    relayProcess = result;
  });

  after(async () => {
    await relayProcess.close();
    await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
  });

  it('relays HTTPS target and streams response back', async () => {
    const origTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const res = await postRelay(relayUrl, {
        url: `https://127.0.0.1:${httpsPort}/secure`,
        method: 'GET',
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers['x-relay-status'], '200');

      const targetHeaders = JSON.parse(res.headers['x-relay-headers']);
      assert.equal(targetHeaders['x-secure'], 'yes');

      assert.equal(res.body, 'https-ok');
    } finally {
      if (origTLS === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTLS;
      }
    }
  });
});

describe('SSRF Protection', () => {
  before(async () => {
    const result = await startRelay(RELAY_PORT); // SSRF enabled (default)
    relayUrl = result.url;
    relayProcess = result;
  });

  after(async () => {
    await relayProcess.close();
  });

  it('returns 403 when target resolves to a private IP', async () => {
    const res = await postRelay(relayUrl, {
      url: 'http://127.0.0.1:9999/secret',
      method: 'GET',
    });
    assert.equal(res.status, 403);
  });
});

describe('Error Handling', () => {
  before(async () => {
    const result = await startRelay(RELAY_PORT, { disableSSRF: true, connectTimeout: 1000 });
    relayUrl = result.url;
    relayProcess = result;
  });

  after(async () => {
    await relayProcess.close();
  });

  it('returns 502 when target is unreachable', async () => {
    const res = await postRelay(relayUrl, {
      url: 'http://127.0.0.1:1/unreachable',
      method: 'GET',
    });
    assert.equal(res.status, 502);
  });

  it('returns 504 when target connection times out', async () => {
    const sockets: net.Socket[] = [];
    const stallingServer = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => stallingServer.listen(0, '127.0.0.1', resolve));
    const stallingPort = (stallingServer.address() as net.AddressInfo).port;

    const res = await postRelay(relayUrl, {
      url: `http://127.0.0.1:${stallingPort}/slow`,
      method: 'GET',
    });
    assert.equal(res.status, 504);

    sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => stallingServer.close(() => resolve()));
  });

  it('returns 400 for unknown routes', async () => {
    const res = await fetch(`${relayUrl}/unknown`);
    assert.equal(res.status, 400);
  });
});

describe('Graceful Shutdown', () => {
  it('stops accepting new connections after close is called', async () => {
    const result = await startRelay(RELAY_PORT, { disableSSRF: true });

    const res = await fetch(`${result.url}/health`);
    assert.equal(res.status, 200);

    await result.close();

    await assert.rejects(
      () => fetch(`${result.url}/health`),
    );
  });
});
