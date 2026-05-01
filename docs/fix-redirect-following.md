# Bug: Proxy Does Not Follow HTTP Redirects

## Problem

YouTube's `googlevideo.com` CDN servers frequently return **302 redirects** to route clients to the optimal edge server. The relay proxy currently passes the 302 response back to the caller as-is instead of following the redirect.

This breaks `youtubei.js` because it checks `response.ok` (which is `false` for 302) and throws `"The server responded with a non 2xx status code"`.

Native `fetch()` follows redirects automatically (default `redirect: "follow"`), so direct connections work fine. The proxy must replicate this behavior.

## Root Cause

In `src/index.ts`, the `http.request` / `https.request` callback receives the 302 response and immediately pipes it back:

```ts
(proxyRes) => {
  const status = proxyRes.statusCode || 502;
  res.writeHead(200, {
    'X-Relay-Status': String(status),
    'X-Relay-Headers': JSON.stringify(responseHeaders),
    'Content-Type': 'application/octet-stream',
  });
  proxyRes.pipe(res);  // Returns the 302 body (HTML) instead of following
}
```

## Fix

Follow 3xx redirects inside the relay handler (up to a reasonable limit like 5 hops). When the upstream returns a 3xx with a `Location` header, make a new request to the redirect URL instead of piping the 3xx back.

### Implementation

Replace the single `requestModule.request(...)` call with a loop or recursive function:

```ts
const MAX_REDIRECTS = 5;

function makeRequest(
  targetUrl: URL,
  method: string,
  reqHeaders: Record<string, string>,
  bodyBuffer: Buffer | null,
  redirectCount: number,
  res: http.ServerResponse,
  start: number,
  parsed: RelayBody
): void {
  if (redirectCount > MAX_REDIRECTS) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Too many redirects');
    return;
  }

  const isHttps = targetUrl.protocol === 'https:';
  const requestModule = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;

  const proxyReq = requestModule.request(
    {
      hostname: targetUrl.hostname,
      port: parseInt(targetUrl.port, 10) || defaultPort,
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: reqHeaders,
    },
    (proxyRes) => {
      const status = proxyRes.statusCode || 502;

      // Follow redirects
      if (status >= 300 && status < 400 && proxyRes.headers.location) {
        // Drain the redirect body
        proxyRes.resume();

        const redirectUrl = new URL(proxyRes.headers.location, targetUrl.href);

        // SSRF check the redirect target too
        // (add resolveAndCheckSSRF call here if SSRF protection is enabled)

        // Follow with GET (POST redirects become GET per HTTP spec, except 307/308)
        const redirectMethod = (status === 307 || status === 308) ? method : 'GET';
        const redirectBody = (status === 307 || status === 308) ? bodyBuffer : null;

        makeRequest(redirectUrl, redirectMethod, reqHeaders, redirectBody, redirectCount + 1, res, start, parsed);
        return;
      }

      // Normal response — pipe back
      const responseHeaders = proxyRes.headers as Record<string, string | string[] | undefined>;
      res.writeHead(200, {
        'X-Relay-Status': String(status),
        'X-Relay-Headers': JSON.stringify(responseHeaders),
        'Content-Type': 'application/octet-stream',
      });
      proxyRes.pipe(res);
      log({ method: parsed.method || 'GET', target: targetUrl.hostname, status, duration_ms: Date.now() - start });
    },
  );

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    }
  });

  proxyReq.setTimeout(30_000, () => {
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Gateway Timeout');
    }
    proxyReq.destroy();
  });

  if (bodyBuffer) {
    proxyReq.write(bodyBuffer);
  }
  proxyReq.end();
}
```

Then call it from the relay handler:

```ts
const bodyBuffer = parsed.body ? Buffer.from(parsed.body, 'base64') : null;
makeRequest(targetUrl, parsed.method || 'GET', reqHeaders, bodyBuffer, 0, res, start, parsed);
```

## Testing

Test with a known redirecting googlevideo URL:

```bash
# This should follow the redirect and return 200 with video bytes
curl -X POST http://localhost:3000/relay \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://rr5---sn-xxx.googlevideo.com/videoplayback?...","method":"GET","headers":{"origin":"https://www.youtube.com","referer":"https://www.youtube.com"}}' \
  -v 2>&1 | head -20
# Look for X-Relay-Status: 200 (not 302)
```

## Impact

Without this fix, **all video downloads through the proxy fail**. The `getInfo()` calls work fine (YouTube API doesn't redirect), but the actual stream download from `googlevideo.com` consistently returns 302s that the proxy doesn't follow.
