#!/bin/sh
set -e

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] Applying Prisma migrations..."
  npx prisma migrate deploy
fi

echo "[entrypoint] Starting: $*"
exec "$@"
