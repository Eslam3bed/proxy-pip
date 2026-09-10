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
RUN apk add --no-cache su-exec
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
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
