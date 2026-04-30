import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

const PROXY_PORT = 0; // OS assigns free port
let proxyUrl: string;
let proxyProcess: { close: () => Promise<void> };

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

async function startProxyStrict(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const { createProxyServer } = await import('../src/index.js');
  const server = createProxyServer(); // No disableSSRF option
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

function httpRequest(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname,
      method: 'GET',
      headers,
    };
    const req = http.request(options, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string> });
      res.resume();
    });
    req.on('error', reject);
    req.end();
  });
}

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
    // Use http.request directly — Node 20 fetch throws on 407 responses
    const res = await httpRequest(`${proxyUrl}/`, { Host: 'example.com' });
    // Non-health, non-proxy request without auth → 407
    assert.equal(res.status, 407);
    assert.ok(res.headers['proxy-authenticate']?.includes('Basic'));
  });

  it('returns 407 when wrong credentials are sent', async () => {
    const badCreds = Buffer.from('wrong:creds').toString('base64');
    const res = await httpRequest(`${proxyUrl}/`, {
      'Proxy-Authorization': `Basic ${badCreds}`,
    });
    assert.equal(res.status, 407);
  });
});

describe('SSRF Protection', () => {
  before(async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';
    const result = await startProxyStrict(PROXY_PORT);
    proxyUrl = result.url;
    proxyProcess = result;
  });

  after(async () => {
    await proxyProcess.close();
  });

  it('returns 403 when CONNECT targets a private IP', async () => {
    const creds = Buffer.from('testuser:testpass').toString('base64');
    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: new URL(proxyUrl).hostname,
        port: new URL(proxyUrl).port,
        method: 'CONNECT',
        path: '127.0.0.1:443',
        headers: { 'Proxy-Authorization': `Basic ${creds}` },
      });
      req.on('connect', (res) => { resolve(res.statusCode ?? 0); });
      req.on('response', (res) => { resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    assert.equal(statusCode, 403);
  });
});

describe('CONNECT Tunneling', () => {
  let targetServer: net.Server;
  let targetPort: number;

  before(async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';

    // TCP echo server as tunnel target
    targetServer = net.createServer((socket) => {
      socket.on('data', (data) => {
        socket.write(`echo:${data.toString()}`);
      });
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

  it('establishes tunnel and pipes data bidirectionally', async () => {
    const creds = Buffer.from('testuser:testpass').toString('base64');
    const proxyUrlObj = new URL(proxyUrl);
    const data = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: proxyUrlObj.hostname,
        port: proxyUrlObj.port,
        method: 'CONNECT',
        path: `127.0.0.1:${targetPort}`,
        headers: { 'Proxy-Authorization': `Basic ${creds}` },
      });
      req.on('connect', (_res, socket) => {
        socket.write('hello');
        socket.on('data', (chunk) => {
          resolve(chunk.toString());
          socket.destroy();
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    assert.equal(data, 'echo:hello');
  });
});

describe('HTTP Forward Proxy', () => {
  let targetServer: http.Server;
  let targetPort: number;

  before(async () => {
    process.env.PROXY_USERNAME = 'testuser';
    process.env.PROXY_PASSWORD = 'testpass';

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
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        host: new URL(proxyUrl).hostname,
        port: new URL(proxyUrl).port,
        method: 'GET',
        path: `http://127.0.0.1:${targetPort}/test-path`,
        headers: { 'Proxy-Authorization': `Basic ${creds}` },
      }, resolve);
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
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
