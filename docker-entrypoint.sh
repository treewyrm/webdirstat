#!/bin/sh
# LinuxServer.io-style PUID/PGID handling: NAS users (esp. Unraid) expect to set the
# uid/gid the container runs as so bind-mounted appdata is writable regardless of host
# ownership. We start as root, remap the runtime 'node' user/group to the requested ids,
# fix ownership of the writable store, then drop privileges via su-exec.
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# -o allows a non-unique id, so remapping onto an id that already exists won't fail.
if [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node
fi
if [ "$(id -u node)" != "$PUID" ]; then
  usermod -o -u "$PUID" node
fi

# The SQLite store must be writable by the (possibly remapped) runtime user. Only /db
# is touched — the scanned share (/data) is read-only and never chowned. Recursive so a
# changed PUID between restarts re-takes ownership of the existing db/wal files.
chown -R node:node /db 2>/dev/null || true

exec su-exec node:node "$@"
