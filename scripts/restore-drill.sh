#!/usr/bin/env bash
# Unattended restore drill. Locally and in CI the pgBackRest repo is a volume.
# Production points that repo at OCI Object Storage (infra/postgres/pgbackrest.production.conf).
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait postgres

# The stanza is created after the server is up. pgBackRest runs as the
# postgres OS user; switching from root is not permitted in this container.
# `info` exits 0 even when the stanza does not exist yet.
if ! docker compose exec -u postgres -T postgres pgbackrest --stanza=main check >/dev/null 2>&1; then
  docker compose exec -u postgres -T postgres pgbackrest --stanza=main --log-level-console=info stanza-create
  docker compose exec -u postgres -T postgres pgbackrest --stanza=main --log-level-console=info check
fi

export DATABASE_URL="${DATABASE_URL:-postgres://postgres:ci@127.0.0.1:55432/practixos_test}"
npx tsx src/db/migrate.ts

MARKER="drill-$(date +%s)"
docker compose exec -T postgres psql -U postgres -d practixos_test -v ON_ERROR_STOP=1 \
  -c "INSERT INTO clinics (slug, legal_name, vertical, display_name) VALUES ('${MARKER}', 'restore drill marker', 'dental', 'Restore drill');"

docker compose exec -u postgres -T postgres pgbackrest --stanza=main backup --type=full

BEFORE="$(docker compose exec -T postgres psql -U postgres -d practixos_test -At \
  -c "SELECT md5(legal_name || slug) FROM clinics WHERE slug = '${MARKER}';" | tr -d '[:space:]')"

docker compose --profile drill rm -sf restore >/dev/null 2>&1 || true
docker volume rm -f practixos_restoredata >/dev/null 2>&1 || true
docker compose --profile drill up -d --build --wait restore

AFTER=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if AFTER="$(docker compose exec -T restore psql -U postgres -d practixos_test -At \
    -c "SELECT md5(legal_name || slug) FROM clinics WHERE slug = '${MARKER}';" | tr -d '[:space:]')"; then
    if [ -n "$AFTER" ]; then
      break
    fi
  fi
  sleep 2
done

docker compose --profile drill rm -sf restore >/dev/null 2>&1 || true
docker volume rm -f practixos_restoredata >/dev/null 2>&1 || true

if [ -z "$BEFORE" ] || [ "$BEFORE" != "$AFTER" ]; then
  echo "FAIL before=${BEFORE:-empty} after=${AFTER:-empty}" >&2
  exit 1
fi

mkdir -p docs/evidence/m0
cat > docs/evidence/m0/restore-drill.md <<EOF
# Restore drill

Result: PASS
Marker: ${MARKER}
Checksum: ${BEFORE}
Restored checksum: ${AFTER}

The backup was taken with pgBackRest and restored into a throwaway container,
which was then destroyed. This run used the local volume repo. Production
archives to OCI Object Storage in ap-mumbai-1.
EOF

echo "PASS ${MARKER} ${BEFORE}"
