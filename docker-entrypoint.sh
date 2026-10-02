#!/bin/sh
# Docker creates a missing bind-mount folder (e.g. /hosted-apps/songer/data) owned by root.
# Take ownership of the data dir while we're still root, then run the app as the unprivileged node user.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || echo "warning: could not chown $DATA_DIR; make it writable by uid 1000"
  exec su-exec node "$@"
fi
exec "$@"
