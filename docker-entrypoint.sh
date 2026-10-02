#!/bin/sh
set -e

# Railway mounts the volume owned by root. The app runs as `node`, so without
# this it cannot write DATA_DIR and silently degrades to memory-only keys —
# every redeploy then invalidates every key that was ever issued.
#
# Start as root purely to fix ownership, then drop privileges before exec'ing
# the app, so nothing that touches the network ever runs as root.
DATA_DIR="${DATA_DIR:-/data}"

# warp-egress.sh is a no-op unless WARP_EGRESS=1; with it, it brings up the
# Cloudflare WARP tunnel as `node` and chains the CONNECT listener through it.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node warp-egress.sh "$@"
fi

exec warp-egress.sh "$@"
