#!/bin/sh
# Optional Cloudflare WARP egress (WARP_EGRESS=1).
#
# YouTube refuses datacentre ranges outright, measured 2026-09-30 on Railway:
# a never-used address fails its first request with the bot wall, and PO
# tokens do not reach that wall. What passes is an address YouTube does not
# class as a datacentre. Cloudflare's free WARP network is one such exit and
# needs no account: wgcf registers a device, wireproxy runs the WireGuard
# tunnel in userspace (no TUN device, no root) and exposes it as a local HTTP
# proxy, and the CONNECT listener chains through it via UPSTREAM_PROXY.
#
# Identity lives under DATA_DIR/warp so a redeploy keeps the same WARP device.
# Delete that directory to get a new identity if the exit ever gets flagged.
set -e

if [ "${WARP_EGRESS:-0}" != "1" ]; then
  exec "$@"
fi

WARP_DIR="${DATA_DIR:-/data}/warp"
WARP_HTTP_PORT="${WARP_HTTP_PORT:-1080}"
mkdir -p "$WARP_DIR"
cd "$WARP_DIR"

log() { printf '{"ts":"%s","msg":"%s"%s}\n' "$(date -u +%FT%TZ)" "$1" "${2:-}"; }

if [ ! -f wgcf-account.toml ]; then
  log "warp: registering a new free WARP device"
  wgcf register --accept-tos >/dev/null
fi
wgcf generate >/dev/null

# wireproxy takes WireGuard's [Interface] and [Peer] verbatim and adds its own
# listener sections. The generated profile already carries Address, DNS, MTU,
# PrivateKey, PublicKey, AllowedIPs and Endpoint.
{
  cat wgcf-profile.conf
  printf '\n[http]\nBindAddress = 127.0.0.1:%s\n' "$WARP_HTTP_PORT"
} > wireproxy.conf

wireproxy -s -c wireproxy.conf &
WIREPROXY_PID=$!

# Wait for the listener, then record the exit address YouTube will see.
i=0
until nc -z 127.0.0.1 "$WARP_HTTP_PORT" 2>/dev/null; do
  i=$((i+1)); [ $i -gt 60 ] && { log "warp: wireproxy did not come up"; exit 1; }
  sleep 0.5
done
EXIT_IP=$(curl -s --max-time 15 -x "http://127.0.0.1:$WARP_HTTP_PORT" https://api.ipify.org || echo unknown)
log "warp: egress ready" ",\"exitIp\":\"$EXIT_IP\",\"httpProxy\":\"127.0.0.1:$WARP_HTTP_PORT\""

# The CONNECT listener chains through the WARP proxy unless the operator set
# an upstream of their own.
export UPSTREAM_PROXY="${UPSTREAM_PROXY:-http://127.0.0.1:$WARP_HTTP_PORT}"

# If the tunnel dies, take the app with it so the platform restarts both.
( wait $WIREPROXY_PID; log "warp: wireproxy exited"; kill -TERM $$ ) &

cd /app
exec "$@"
