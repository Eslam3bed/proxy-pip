# pip-proxy Design Spec

## Goal

A lightweight HTTP forward proxy deployed on Railway that routes YouTube API traffic from Cloud Run through a non-blocked IP. Supports CONNECT tunneling for HTTPS, authenticates with Basic Auth, and pipes data bidirectionally with zero buffering.

## Architecture

Single-file Node.js server using built-in `http` and `net` modules — no frameworks. Two request paths on one `http.Server`:

1. **`'connect'` event** — HTTPS tunneling (primary path). Validates auth, resolves target hostname, checks for SSRF, opens TCP socket via `net.connect()`, pipes bidirectionally with `socket.pipe()`.
2. **`'request'` event** — HTTP forward proxy requests and health check. Validates auth (skipped for `/health`), forwards via `http.request()`, pipes response stream back.

## Tech Stack

- **Runtime:** Node.js 20
- **Language:** TypeScript
- **Runtime deps:** None (stdlib only: `http`, `net`, `crypto`, `dns`)
- **Dev deps:** `typescript`, `tsx`
- **Test runner:** `node:test` (built-in)
- **Deployment:** Railway via GitHub Actions CI/CD

## File Structure

```
pip-proxy/
├── src/
│   └── index.ts           # Server, auth, proxy, health (~150-200 lines)
├── test/
│   └── proxy.test.ts      # Integration tests (node:test)
├── .github/
│   └── workflows/
│       └── deploy.yml     # Build → Test → Deploy to Railway
├── Dockerfile             # Multi-stage: build TS → run node:20-alpine
├── .dockerignore
├── tsconfig.json
├── package.json
└── .gitignore
```

## Functional Design

### Health Check

`GET /health` → `200 OK` with `{"status":"ok"}`. No auth required. Detected by: request URL is `/health` and method is GET (not a proxy request — no absolute URI).

### Authentication

Every proxy request (HTTP and CONNECT) must include `Proxy-Authorization: Basic <base64(user:pass)>`.

- Parse the header, base64-decode, split on first `:`.
- Compare using `crypto.timingSafeEqual` against `PROXY_USERNAME` and `PROXY_PASSWORD` env vars.
- On failure: respond `407 Proxy Authentication Required` with `Proxy-Authenticate: Basic realm="pip-proxy"` header.

### CONNECT Tunneling (HTTPS)

1. Parse target `host:port` from request URL.
2. Validate auth.
3. DNS-resolve the hostname, check resolved IP against private ranges (SSRF).
4. `net.connect({ host, port })` with 30s timeout on connection establishment.
5. On connect: respond `HTTP/1.1 200 Connection Established\r\n\r\n`.
6. `clientSocket.pipe(targetSocket)` and `targetSocket.pipe(clientSocket)`.
7. `setNoDelay(true)` on both sockets to disable Nagle's algorithm.
8. On error/close on either side: destroy both sockets.

### HTTP Forward Proxy

1. Detect proxy request by absolute URI in request URL (starts with `http://`).
2. Validate auth.
3. Parse target URL, resolve hostname, check for SSRF.
4. `http.request()` to target, pipe client request body to target.
5. Pipe target response back to client, forwarding status code and headers.

### SSRF Protection

Before connecting to any target, resolve the hostname to an IP and reject if it falls in:
- `127.0.0.0/8`
- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`
- `0.0.0.0/8`
- `169.254.0.0/16` (link-local)
- `::1`, `fc00::/7` (IPv6 private)

Respond `403 Forbidden`.

### Logging

Structured JSON to stdout:
```json
{"ts":"ISO8601","method":"CONNECT","target":"www.youtube.com:443","status":200,"duration_ms":15}
```

No credentials or body content logged. `LOG_LEVEL=debug` adds DNS resolution times and socket events.

### Graceful Shutdown

On `SIGTERM`: stop accepting new connections, wait up to 10s for active connections to drain, then `process.exit(0)`.

## Performance Design

| Technique | Why |
|-----------|-----|
| `socket.pipe(socket)` | Zero-copy kernel-side data transfer |
| `setNoDelay(true)` | Disables Nagle's algorithm — lower latency for small packets |
| No body parsing/buffering | Streams pass through untouched |
| Early auth check | Reject before any network I/O to target |
| 30s connect timeout only | No timeout on active streams (video downloads run long) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROXY_USERNAME` | Yes | — | Basic auth username |
| `PROXY_PASSWORD` | Yes | — | Basic auth password |
| `PORT` | No | `3128` | Listen port |
| `LOG_LEVEL` | No | `info` | `info` or `debug` |

## CI/CD Design

GitHub Actions workflow mirrors quiq-api pattern:

1. **Trigger:** Push to `main`
2. **Build:** Install deps, compile TypeScript
3. **Test:** Start proxy server, run integration tests, stop server
4. **Deploy:** `railway up --service=$RAILWAY_SERVICE_ID` using Railway CLI container

Secrets/vars configured in GitHub repo settings:
- Secret: `RAILWAY_DEPLOYMENT_ACCESS_TOKEN`
- Variable: `RAILWAY_SERVICE_ID`

## Error Responses

| Status | Condition |
|--------|-----------|
| `407 Proxy Authentication Required` | Missing or invalid credentials |
| `403 Forbidden` | Target resolves to private IP |
| `502 Bad Gateway` | Cannot connect to target |
| `504 Gateway Timeout` | Connection to target timed out (30s) |

## Test Plan

Integration tests using `node:test`:

1. **Health check** — `GET /health` returns 200 without auth
2. **Auth rejection** — Proxy request without auth returns 407
3. **Auth rejection (bad creds)** — Wrong credentials returns 407
4. **CONNECT tunnel** — Valid auth, tunnel established, data pipes through
5. **HTTP forward proxy** — Valid auth, request forwarded, response piped back
6. **SSRF block** — CONNECT to `127.0.0.1` returns 403
7. **Graceful shutdown** — SIGTERM drains connections

## Success Criteria

1. YouTube metadata fetches work through the proxy
2. Video downloads stream without buffering or memory accumulation
3. All unauthenticated requests rejected
4. < 50ms latency added to connection establishment
5. CI/CD deploys automatically on push to main
