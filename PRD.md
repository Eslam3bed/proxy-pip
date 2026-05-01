# pip-proxy — HTTP Relay Service PRD

## Overview

A lightweight HTTP relay deployed on Railway. The primary consumer is the `yt_to_storage_pip` service (deployed on Cloud Run), which sends outbound HTTP requests through this relay to avoid IP-based blocking by Google.

## Problem

Google blocks Cloud Run IP ranges from accessing YouTube. A forward proxy (CONNECT tunneling) doesn't work on Railway because Railway's HTTP routing layer intercepts CONNECT requests. An HTTP relay avoids this by making the outbound request server-side and streaming the response back.

## Solution

A Node.js HTTP relay that:
- Receives fetch requests as JSON (`POST /relay`)
- Makes the actual HTTP request to the target URL from Railway's IP
- Streams the response (headers + body) back to the caller
- Is stateless, single-process, minimal dependencies

## How It Works

```
yt_to_storage_pip (Cloud Run)
  → POST /relay
    Body: { url, method, headers, body }
  → pip-proxy (Railway)
    fetches target URL from Railway's IP
    streams response back (status + headers + body)
  → YouTube (sees Railway IP, not Cloud Run IP)
```

The consumer's custom `fetch` function serializes each fetch call into a relay request. The relay executes it and returns the raw response. From `youtubei.js`'s perspective, it's just a normal fetch — the relay is transparent.

## Functional Requirements

### FR-1: HTTP Relay Endpoint

`POST /relay`

**Request body (JSON):**
```json
{
  "url": "https://www.youtube.com/...",
  "method": "GET",
  "headers": { "User-Agent": "...", "Accept": "..." },
  "body": "optional base64-encoded body"
}
```

**Response:**
- Status code: mirrors the target's status code
- Headers: `X-Relay-Status` with target status, `X-Relay-Headers` with JSON-encoded target response headers
- Body: raw streamed body from target (no buffering)

**Why this format:** The response body is streamed raw (not wrapped in JSON) so large video downloads pipe through without buffering. Response metadata goes in headers.

### FR-2: Health Check
- `GET /health` returns `200 OK`

### FR-3: Logging
- Log each relay request: timestamp, target hostname, status, duration
- Do NOT log full URLs with query params or request/response bodies
- Structured JSON logs

## Non-Functional Requirements

### NFR-1: Performance
- Stream response body directly — do not buffer in memory
- Handle concurrent connections (at least 50 simultaneous)
- Request timeout: 30s for connection, no timeout for response streaming (video downloads can be long)

### NFR-2: Security (future)
- Authentication will be added later
- For now, the relay is open (no auth required)
- SSRF protection: reject relay requests to private/internal IP ranges (127.x, 10.x, 192.168.x, 172.16-31.x)

### NFR-3: Reliability
- Graceful shutdown on SIGTERM (drain active connections, 10s grace period)

### NFR-4: Simplicity
- Minimal files
- Use Node.js built-in `http` module or lightweight framework
- Minimal dependencies

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Listen port (default: 3000) |

## Tech Stack

- **Runtime:** Node.js 20
- **Language:** TypeScript
- **Deployment:** Railway (Dockerfile or Nixpacks)

## Error Responses

- `400 Bad Request` — missing `url` in request body
- `403 Forbidden` — target resolves to a private IP (SSRF protection)
- `502 Bad Gateway` — cannot connect to target
- `504 Gateway Timeout` — target connection timed out

## Consumer Integration

The consumer (`yt_to_storage_pip`) creates a custom `fetch` function:

```typescript
function createRelayFetch(relayUrl: string): typeof fetch {
  return async (input, init) => {
    const targetUrl = typeof input === "string" ? input : input.toString();
    const res = await fetch(`${relayUrl}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: targetUrl,
        method: init?.method || "GET",
        headers: init?.headers || {},
        body: init?.body ? Buffer.from(init.body as any).toString("base64") : undefined,
      }),
    });

    const status = parseInt(res.headers.get("x-relay-status") || String(res.status));
    const targetHeaders = JSON.parse(res.headers.get("x-relay-headers") || "{}");

    return new Response(res.body, { status, headers: targetHeaders });
  };
}
```

This is passed to `Innertube.create({ fetch: relayFetch })`.

## Out of Scope (for now)

- Authentication (will be added later)
- TLS on the relay itself (Railway provides edge TLS)
- Rate limiting
- Caching
- WebSocket or streaming request bodies

## Success Criteria

1. `yt_to_storage_pip` can fetch YouTube metadata through the relay
2. `yt_to_storage_pip` can stream full video downloads through the relay
3. Video downloads stream without buffering or memory accumulation on the relay
