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
