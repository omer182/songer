#!/bin/sh
# Docker creates a missing bind-mount folder (e.g. /hosted-apps/songer/data) owned by root.
# While still root: take ownership of the data dir, then run the app as the unprivileged node user.
# If node still can't write there (NFS/CIFS mounts, user-namespace remapping), run as root instead of crashing.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  if su-exec node sh -c "touch '$DATA_DIR/.write-test' && rm -f '$DATA_DIR/.write-test'" 2>/dev/null; then
    exec su-exec node "$@"
  fi
  echo "songer: $DATA_DIR is not writable by the node user ($(stat -c '%u:%g %a' "$DATA_DIR" 2>/dev/null)); running as root." >&2
  echo "songer: to run unprivileged, on the host: sudo chown -R 1000:1000 <data folder>" >&2
fi
exec "$@"
