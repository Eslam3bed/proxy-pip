# pip-proxy — Forward Proxy Service PRD

## Overview

A lightweight, general-purpose HTTP forward proxy deployed on Railway. Its primary consumer is the `yt_to_storage_pip` service (deployed on Cloud Run), which routes YouTube API traffic through this proxy to avoid IP-based blocking.

## Problem

Google blocks Cloud Run IP ranges from accessing YouTube. The current workarounds (PO Token Server, Deno runtime, Cloudflare WARP) add complexity and are unreliable. A forward proxy on a different provider (Railway) provides a clean, non-blocked IP.

## Solution

A Node.js forward proxy that:
- Accepts HTTP forward proxy requests (standard proxy protocol)
- Supports the CONNECT method for HTTPS tunneling (required — YouTube uses HTTPS)
- Authenticates every request with HTTP Basic Auth
- Is stateless, single-process, minimal dependencies

## Functional Requirements

### FR-1: HTTP Forward Proxy
- Handle standard HTTP proxy requests (absolute-URI in request line)
- Support the HTTP CONNECT method for tunneling HTTPS traffic
- Stream data bidirectionally without buffering (pipe TCP sockets)

### FR-2: Basic Authentication
- Every request (including CONNECT) must include a `Proxy-Authorization` header
- Single credential pair: username + password, configured via environment variables
- Reject unauthenticated requests with `407 Proxy Authentication Required`
- Use timing-safe comparison to prevent timing attacks

### FR-3: Logging
- Log each request: timestamp, method, target host, status, duration
- Do NOT log credentials or request/response bodies
- Structured JSON logs for Railway log viewer

### FR-4: Health Check
- `GET /health` returns `200 OK` (no auth required)
- Used by Railway for container readiness

## Non-Functional Requirements

### NFR-1: Performance
- Zero buffering — pipe streams directly between client and target
- Handle concurrent connections (at least 50 simultaneous)
- Connection timeout: 30s for establishment, no timeout for active streams (video downloads can be long)

### NFR-2: Security
- No open proxy — all requests require valid Basic Auth
- Do not resolve/follow redirects on behalf of the client
- Reject proxy requests to private/internal IP ranges (127.x, 10.x, 192.168.x, 172.16-31.x) to prevent SSRF

### NFR-3: Reliability
- Graceful shutdown on SIGTERM (drain active connections, 10s grace period)
- Process crash recovery handled by Railway's container restart

### NFR-4: Simplicity
- Single `index.ts` file (or minimal files)
- Minimal dependencies — prefer Node.js built-in `http` and `net` modules
- No framework (no Express, no Fastify)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PROXY_USERNAME` | Yes | Basic auth username |
| `PROXY_PASSWORD` | Yes | Basic auth password |
| `PORT` | No | Listen port (default: 3128) |
| `LOG_LEVEL` | No | `info` or `debug` (default: `info`) |

## Tech Stack

- **Runtime:** Node.js 20
- **Language:** TypeScript
- **Dependencies:** Minimal — ideally just `typescript` and `tsx` for dev
- **Deployment:** Railway (Dockerfile or Nixpacks)

## API Behavior

### Standard HTTP Proxy Request
```
GET http://example.com/path HTTP/1.1
Proxy-Authorization: Basic base64(user:pass)
```
Proxy fetches the target and streams the response back.

### CONNECT Tunnel (for HTTPS)
```
CONNECT www.youtube.com:443 HTTP/1.1
Proxy-Authorization: Basic base64(user:pass)
```
Proxy establishes TCP connection to target, responds `200 Connection Established`, then pipes data bidirectionally. The proxy never sees the encrypted content.

### Health Check
```
GET /health HTTP/1.1
```
Returns `200 OK` — no auth, not a proxy request (no absolute URI or CONNECT).

### Error Responses
- `407 Proxy Authentication Required` — missing or invalid credentials
- `403 Forbidden` — target is a private IP (SSRF protection)
- `502 Bad Gateway` — cannot connect to target
- `504 Gateway Timeout` — connection to target timed out

## Deployment

- **Platform:** Railway
- **Dockerfile:** Multi-stage (build TypeScript, run with slim Node image)
- **Resources:** Minimal — this is a pass-through proxy, CPU/memory usage is negligible
- **Scaling:** Single instance is sufficient for single-consumer use

## Consumer Integration

The primary consumer (`yt_to_storage_pip`) integrates by:

1. Setting env var: `PROXY_URL=http://user:pass@<railway-host>:<port>`
2. The app creates a proxy-aware `fetch` function using `undici` or `http-proxy-agent`
3. Passes this custom fetch to `Innertube.create({ fetch: proxyFetch })`
4. All YouTube API calls and video downloads route through the proxy

### Authentication Flow
```
yt_to_storage_pip (Cloud Run)
  → CONNECT www.youtube.com:443
    Proxy-Authorization: Basic base64(user:pass)
  → pip-proxy (Railway)
    validates credentials
    opens TCP to www.youtube.com:443
    responds: 200 Connection Established
    pipes bidirectionally
  → YouTube (sees Railway IP, not Cloud Run IP)
```

## Out of Scope

- TLS on the proxy itself (Railway provides edge TLS via its routing layer)
- Multiple credential pairs / API key management
- Rate limiting (single consumer, trusted)
- Caching (video streams are too large, YouTube responses are dynamic)
- Access control lists / domain allowlisting (general-purpose proxy)

## Success Criteria

1. `yt_to_storage_pip` can fetch YouTube metadata through the proxy
2. `yt_to_storage_pip` can stream full video downloads through the proxy
3. All requests without valid Basic Auth are rejected
4. Proxy adds < 50ms latency to connection establishment
5. Video downloads stream without buffering or memory accumulation
