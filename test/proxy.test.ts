import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Embedded self-signed test cert (valid 10 years, CN=localhost)
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDbIFIge7vYGEkJ
/DU16OhV6Ff3tFOuf7gbWZ4Gg2Y5IfZ7xgN05JPHWwhsSoamSq/9DDrgvQ3IeKT+
NEWwUbyChKASz0Y4zJ6gIz6U4jb5Q+XWMzobBh6SpuXp56+ttcEXzto75uolf6EQ
w+V/S6SKDyO9wwVPDU8qs1wdNcKXoiWbAijnDXK2Wj8nBi/B4XcmOIu1/CVA/5NC
3andyzA0enLt3znYlxOODEVUrQQ7ptMSnlY7jxxw/u2s0d+k/WE4GbLjwQ3nuOKA
BkuySe43RDbsDEAGt71sbn+Gyf/0v7sIMwTKEhqDVYQwnoGhXk2xoYN95JM/5o/G
8vgqSosjAgMBAAECggEBAMvqnALWosxKbU35gpsUj4HConpFOcqd2Hq7Py/Yf/yS
+oncj8LsJAnVUVVVVVDTGEtoYjJaPMVeYEyf4Gpg5gif20cl1Ldu0/86TTbH/Vii
MvTO3zfezfyzjCnMDdSd23+IY9Zy4VrcFss/QgbgIdLIm/4vynTyccXO+93C9b+c
z/RVz36kymgZo+6kSxs3oUs+p9ODTnp4KkxMrGPtTefUKrNBLFzhQ6s66z+unRpg
WY8Lep0O8kwCLlxJYLVL/OLs2k3rWCtkFCcmF3JTv+YgGA60TZCnRWDstwCrG8l2
VHZVakFrnQNRgYTSRg08TiSn2pl29cN4Xu9WpxQhleECgYEA+UfyfQWQ/2YNV8XM
lsJeljIRlC73dBEsJGF4uGQIZgNXAGn8QyZ1ffMHPSxfYFhsXQ1ridTeYxn+ESMy
X2avq26t3bot27d85qK7vacohhjVLo52fQcL3bqPoxfneK2Ls5D9C8VeZo3DfZ/i
bhbWHZz0c8+iWVtYgcJFUw0K570CgYEA4QhNy7rZyF54m8oHRSZixhPNS15W3yrt
yl5EavM7FXUllfp+NRRdHr7n/cDeLwHHyMgcgspq4SdeGq878p+qvEFuILTknqQ8
lxfLrWOVpxL/5/LhwML4qeGliifJTsKNRxkCjwbcLIRtc/556TLGzRCjU3lUWJM2
2mxZ3ltrfF8CgYADNdX9njC72UiatMVpu58UOBjZ27D8Iax723V+imtBRRG9w5+o
Dbq9oH+bXhLsXrcmi6Gy6Lbkd9U5y0Y+zEe+4XIDxP4KMla9caMRUjHHaFJ2gwcr
nQeeF2T6KLimaTW/XkKkACqzD2hRGdoEqO6g+wB67VWd6Ps+0I2sACL/0QKBgCHh
SS0yLZXQO2JhMWUE2XwvAQqm4ndpFDISrURY6H1bjNQeyZ+eOELnxS/cONdk8jpV
fo1mgl7xuWZVGbZ2uZLsWvNLqNwFqCWrbHvncWGdJ7A5TinicOPK2EyLnvBftDuP
FWaJRt7g9UWwe5RTk8DOD3kC3GMVjv2lsIYcx3sLAoGAb8mWmFdtY+9QRsRKiONY
VYCM+Jsij+kZDhFdzCKDeWv+1qvStTnamhqEPSWESS9BFplj7j1FrpBBw5XRaVyK
1XpFHQFgDi1WBsgnitGIikhK1+Sp5RqZvCE6gNmVq4CnBIk1/sGcX7JR+76ltWFK
dwdhZLqoDpoLMuhRXrdVoeY=
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQDR65HuyBrmcDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjYwNTAxMTA0NTM2WhcNMzYwNDI4MTA0NTM2WjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDb
IFIge7vYGEkJ/DU16OhV6Ff3tFOuf7gbWZ4Gg2Y5IfZ7xgN05JPHWwhsSoamSq/9
DDrgvQ3IeKT+NEWwUbyChKASz0Y4zJ6gIz6U4jb5Q+XWMzobBh6SpuXp56+ttcEX
zto75uolf6EQw+V/S6SKDyO9wwVPDU8qs1wdNcKXoiWbAijnDXK2Wj8nBi/B4Xcm
OIu1/CVA/5NC3andyzA0enLt3znYlxOODEVUrQQ7ptMSnlY7jxxw/u2s0d+k/WE4
GbLjwQ3nuOKABkuySe43RDbsDEAGt71sbn+Gyf/0v7sIMwTKEhqDVYQwnoGhXk2x
oYN95JM/5o/G8vgqSosjAgMBAAEwDQYJKoZIhvcNAQELBQADggEBADLflc5zWMUi
lbtsMmCuTwfVZ03D4a9cEed/rB5Kat61U3Wq/78/QUaqfDLyKXAMsLvObQEHmroO
2TzZGxrToy9xDgzPI3qgBthJvGDTJzHgNi+09YOjOBFlqbtLySjBBxF0+X7eAoxC
NETG2GerPXQz4KdgOiYc15otX2vLvBkFUimM0BbpRr7xj1j7BePpkgTsZXK6nHgJ
O/aen7wJT8nnFgL99p/UUc99kil4wk1XeTjI7/tlXvFy5SmRGKV07lARMFXp9UIi
up/f6qcHP0gaoNlwaglPggYZYCt+C6bq7sCj73upCEraIZWG0gCQCzkURvWSihj+
owWKcqpH4yQ=
-----END CERTIFICATE-----`;

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
    httpsServer = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (_req, res) => {
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
