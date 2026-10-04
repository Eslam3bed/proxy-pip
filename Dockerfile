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

# su-exec lets the entrypoint fix volume ownership as root and then drop to
# `node` before the app starts. USER is deliberately not set here — the
# entrypoint does the dropping, because the chown must happen first.
#
# wgcf and wireproxy power the optional WARP egress (WARP_EGRESS=1, see
# warp-egress.sh). Pinned releases, fetched at build time, so the image is
# hermetic; both run unprivileged. curl and netcat are for the readiness and
# exit-address checks in that script.
ARG WGCF_VERSION=2.3.0
ARG WIREPROXY_VERSION=1.1.3
RUN apk add --no-cache su-exec ca-certificates curl netcat-openbsd \
    && wget -qO /usr/local/bin/wgcf "https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_linux_amd64" \
    && chmod +x /usr/local/bin/wgcf \
    && wget -qO /tmp/wireproxy.tar.gz "https://github.com/whyvl/wireproxy/releases/download/v${WIREPROXY_VERSION}/wireproxy_linux_amd64.tar.gz" \
    && tar -xzf /tmp/wireproxy.tar.gz -C /usr/local/bin wireproxy \
    && chmod +x /usr/local/bin/wireproxy && rm /tmp/wireproxy.tar.gz
COPY docker-entrypoint.sh warp-egress.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/warp-egress.sh
ENTRYPOINT ["docker-entrypoint.sh"]

# Only the HTTP port is EXPOSEd, and it matches what Railway actually runs.
# Railway injects PORT=8080, so that is the port the relay binds in
# production; the 3000 in src/index.ts is only the local-dev fallback.
# EXPOSE is what Railway offers as the public domain's target, so naming
# anything else here points the domain at a port nothing listens on.
#
# The CONNECT listener is reached through Railway TCP Proxy, configured
# explicitly against TCP_PORT, and deliberately not EXPOSEd.
EXPOSE 8080

CMD ["node", "dist/index.js"]
