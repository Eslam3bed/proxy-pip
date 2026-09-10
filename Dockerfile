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

USER node

# Only the HTTP port is EXPOSEd. Railway picks the public domain's target
# port from EXPOSE, and listing two made it choose the CONNECT port and
# black-hole every relay request behind a 407. The CONNECT listener is
# reached through Railway TCP Proxy, which is configured explicitly and
# does not need EXPOSE.
EXPOSE 3000

CMD ["node", "dist/index.js"]
