import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KeyStore, resolveDataDir } from '../src/keys.js';
import { createRelayServer } from '../src/index.js';
import { createConnectProxy, authenticateProxyRequest } from '../src/connect.js';
import { SettingsConfig } from '../src/settings.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as net.AddressInfo).port));
  });
}

function request(
  port: number,
  options: http.RequestOptions,
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('KeyStore', () => {
  it('returns a usable secret exactly once and verifies it', () => {
    const store = new KeyStore(null);
    const { key, secret } = store.create('engine');

    assert.match(key.id, /^pk_[0-9a-f]{16}$/);
    assert.match(secret, /^sk_/);
    assert.equal(store.verifySecret(secret)?.id, key.id);
    assert.equal(store.verifyPair(key.id, secret)?.id, key.id);
  });

  it('never stores the plaintext secret', () => {
    const store = new KeyStore(null);
    const { key, secret } = store.create('engine');
    assert.notEqual(key.secretHash, secret);
    assert.ok(!JSON.stringify(key).includes(secret));
  });

  it('rejects a wrong secret and a wrong id', () => {
    const store = new KeyStore(null);
    const { key, secret } = store.create('engine');
    assert.equal(store.verifySecret('sk_nope'), null);
    assert.equal(store.verifyPair('pk_deadbeefdeadbeef', secret), null);
    assert.equal(store.verifyPair(key.id, 'sk_nope'), null);
  });

  it('stops accepting a revoked key', () => {
    const store = new KeyStore(null);
    const { key, secret } = store.create('engine');
    assert.equal(store.revoke(key.id), true);
    assert.equal(store.verifySecret(secret), null);
    assert.equal(store.count, 0);
  });

  it('persists keys across instances when a data dir is writable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pip-keys-'));
    const store = new KeyStore(resolveDataDir(dir));
    const { key, secret } = store.create('engine');

    const reloaded = new KeyStore(resolveDataDir(dir));
    assert.equal(reloaded.verifySecret(secret)?.id, key.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('degrades to memory-only when the data dir cannot be created', () => {
    // A directory whose parent is a regular file. mkdir fails ENOTDIR for
    // root and non-root alike, on Linux and macOS.
    //
    // Do NOT reach for a path under /proc here: mkdirSync(recursive) against
    // procfs blocks forever on Linux rather than throwing, which wedges the
    // whole run.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pip-nodir-')), 'a-file');
    fs.writeFileSync(file, 'not a directory');

    assert.equal(resolveDataDir(path.join(file, 'keys')), null);
    assert.equal(new KeyStore(null).persistent, false);

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('Proxy-Authorization parsing', () => {
  it('accepts a valid id:secret pair', () => {
    const store = new KeyStore(null);
    const { key, secret } = store.create('engine');
    const header = 'Basic ' + Buffer.from(`${key.id}:${secret}`).toString('base64');
    assert.equal(authenticateProxyRequest(header, store)?.id, key.id);
  });

  it('rejects missing, malformed and non-Basic headers', () => {
    const store = new KeyStore(null);
    store.create('engine');
    assert.equal(authenticateProxyRequest(undefined, store), null);
    assert.equal(authenticateProxyRequest('Bearer abc', store), null);
    assert.equal(authenticateProxyRequest('Basic ' + Buffer.from('no-colon').toString('base64'), store), null);
  });
});

describe('/v1/verify', () => {
  let server: http.Server;
  let port: number;
  let secret: string;

  before(async () => {
    const store = new KeyStore(null);
    secret = store.create('engine').secret;
    server = createRelayServer({ store, disableSSRF: true });
    port = await listen(server);
  });

  after(() => server.close());

  it('401s without a secret', async () => {
    const res = await request(port, { method: 'GET', path: '/v1/verify' });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  it('401s with a bad secret', async () => {
    const res = await request(port, {
      method: 'GET', path: '/v1/verify', headers: { Authorization: 'Bearer sk_nope' },
    });
    assert.equal(res.status, 401);
  });

  it('returns key identity for a valid secret', async () => {
    const res = await request(port, {
      method: 'GET', path: '/v1/verify', headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.name, 'engine');
  });

  it('also accepts the X-Relay-Secret header', async () => {
    const res = await request(port, {
      method: 'GET', path: '/v1/verify', headers: { 'X-Relay-Secret': secret },
    });
    assert.equal(res.status, 200);
  });
});

describe('/relay authentication', () => {
  it('rejects unauthenticated calls when the open flag is off', async () => {
    const store = new KeyStore(null);
    const server = createRelayServer({ store, disableSSRF: true, allowUnauthenticated: false });
    const port = await listen(server);

    const res = await request(port, {
      method: 'POST', path: '/relay', headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ url: 'http://127.0.0.1:1/' }));

    assert.equal(res.status, 401);
    server.close();
  });

  it('still serves unauthenticated calls while the open flag is on', async () => {
    const store = new KeyStore(null);
    const target = http.createServer((_req, res) => { res.writeHead(200); res.end('hi'); });
    const targetPort = await listen(target);

    const server = createRelayServer({ store, disableSSRF: true, allowUnauthenticated: true });
    const port = await listen(server);

    const res = await request(port, {
      method: 'POST', path: '/relay', headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ url: `http://127.0.0.1:${targetPort}/` }));

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-relay-status'], '200');
    server.close();
    target.close();
  });

  it('serves an authenticated call when the open flag is off', async () => {
    const store = new KeyStore(null);
    const { secret } = store.create('engine');
    const target = http.createServer((_req, res) => { res.writeHead(200); res.end('hi'); });
    const targetPort = await listen(target);

    const server = createRelayServer({ store, disableSSRF: true, allowUnauthenticated: false });
    const port = await listen(server);

    const res = await request(port, {
      method: 'POST',
      path: '/relay',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    }, JSON.stringify({ url: `http://127.0.0.1:${targetPort}/` }));

    assert.equal(res.status, 200);
    assert.equal(res.body, 'hi');
    server.close();
    target.close();
  });
});

describe('/settings', () => {
  const settings: SettingsConfig = {
    adminPassword: 'hunter2',
    publicRelayUrl: 'https://relay.example.com',
    publicTcpHost: 'tcp.example.com',
    publicTcpPort: '12345',
  };
  const basic = 'Basic ' + Buffer.from('admin:hunter2').toString('base64');

  let server: http.Server;
  let port: number;

  before(async () => {
    server = createRelayServer({ store: new KeyStore(null), settings, disableSSRF: true });
    port = await listen(server);
  });

  after(() => server.close());

  it('401s without admin credentials', async () => {
    const res = await request(port, { method: 'GET', path: '/settings' });
    assert.equal(res.status, 401);
    assert.match(String(res.headers['www-authenticate']), /Basic/);
  });

  it('401s with a wrong password', async () => {
    const res = await request(port, {
      method: 'GET', path: '/settings',
      headers: { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') },
    });
    assert.equal(res.status, 401);
  });

  it('serves the settings page to an admin', async () => {
    const res = await request(port, {
      method: 'GET', path: '/settings', headers: { Authorization: basic },
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /pip-proxy access/);
  });

  it('creates a key and returns link, secret and yt-dlp proxy URL', async () => {
    const res = await request(port, {
      method: 'POST', path: '/settings/api/keys',
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
    }, JSON.stringify({ name: 'core-engine' }));

    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.relayUrl, 'https://relay.example.com');
    assert.match(body.secret, /^sk_/);
    assert.equal(body.proxyUrl, `http://${body.keyId}:${body.secret}@tcp.example.com:12345`);
  });

  it('lists keys without ever exposing a secret', async () => {
    const res = await request(port, {
      method: 'GET', path: '/settings/api/keys', headers: { Authorization: basic },
    });
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes('sk_'));
  });
});

describe('CONNECT forward proxy', () => {
  let proxy: http.Server;
  let proxyPort: number;
  let target: net.Server;
  let targetPort: number;
  let creds: string;

  before(async () => {
    const store = new KeyStore(null);
    const { key, secret } = store.create('engine');
    creds = Buffer.from(`${key.id}:${secret}`).toString('base64');

    target = net.createServer((socket) => {
      socket.on('data', () => socket.write('PONG'));
    });
    targetPort = await new Promise((resolve) => {
      target.listen(0, () => resolve((target.address() as net.AddressInfo).port));
    });

    proxy = createConnectProxy({ store, disableSSRF: true, log: () => {} });
    proxyPort = await listen(proxy);
  });

  after(() => { proxy.close(); target.close(); });

  it('407s a CONNECT with no Proxy-Authorization', async () => {
    const line = await new Promise<string>((resolve) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`);
      });
      socket.once('data', (d) => { resolve(d.toString()); socket.destroy(); });
    });
    assert.match(line, /^HTTP\/1\.1 407/);
    assert.match(line, /Proxy-Authenticate: Basic/);
  });

  it('407s a CONNECT with a bad secret', async () => {
    const bad = Buffer.from('pk_deadbeefdeadbeef:sk_nope').toString('base64');
    const line = await new Promise<string>((resolve) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nProxy-Authorization: Basic ${bad}\r\n\r\n`);
      });
      socket.once('data', (d) => { resolve(d.toString()); socket.destroy(); });
    });
    assert.match(line, /^HTTP\/1\.1 407/);
  });

  it('drains on close after a client disconnects, leaking no upstream socket', async () => {
    // Regression: the proxy used to destroy the upstream socket only on a
    // client 'error'. A clean disconnect emits 'close' instead, so the
    // upstream lingered and close() never completed.
    const store = new KeyStore(null);
    const { key, secret } = store.create('engine');
    const auth = Buffer.from(`${key.id}:${secret}`).toString('base64');

    const solo = createConnectProxy({ store, disableSSRF: true, log: () => {} });
    const soloPort = await listen(solo);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(soloPort, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      });
      socket.once('data', (chunk) => {
        if (!/^HTTP\/1\.1 200/.test(chunk.toString())) { reject(new Error(chunk.toString())); return; }
        socket.end(); // clean FIN, not a reset
        resolve();
      });
      socket.on('error', reject);
    });

    const drained = await Promise.race([
      new Promise<boolean>((resolve) => solo.close(() => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);

    assert.equal(drained, true, 'server did not drain — an upstream socket leaked');
  });

  it('establishes a tunnel and pipes bytes with valid credentials', async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nProxy-Authorization: Basic ${creds}\r\n\r\n`);
      });

      let established = false;
      socket.on('data', (chunk) => {
        const text = chunk.toString();
        if (!established) {
          if (!/^HTTP\/1\.1 200/.test(text)) { reject(new Error(text)); return; }
          established = true;
          socket.write('PING');
          return;
        }
        resolve(text);
        socket.destroy();
      });
      socket.on('error', reject);
    });

    assert.equal(result, 'PONG');
  });
});
