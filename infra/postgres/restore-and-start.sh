#!/bin/bash
set -euo pipefail
mkdir -p /var/lib/postgresql/data
find /var/lib/postgresql/data -mindepth 1 -maxdepth 1 -exec rm -rf {} +
chown postgres:postgres /var/lib/postgresql/data
chmod 700 /var/lib/postgresql/data
su -s /bin/bash postgres -c "pgbackrest --stanza=main --log-level-console=info restore"
exec docker-entrypoint.sh postgres -c archive_mode=off
