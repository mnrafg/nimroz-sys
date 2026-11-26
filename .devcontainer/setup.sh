#!/usr/bin/env bash
set -euo pipefail

# Never replace an existing environment or point schema setup at a remote DB.
if [ ! -f .env ]; then
  node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync('.env', [
  'DATABASE_URL="mysql://nimroz:codespaces-dev-only@mysql:3306/nimroz_dev"',
  `AUTH_SECRET="${randomBytes(48).toString('hex')}"`,
  `DEVICE_MASTER_KEY="${randomBytes(32).toString('hex')}"`,
  'SEED_ADMIN_EMAIL="admin@localhost"',
  `SEED_ADMIN_PASSWORD="${randomBytes(24).toString('base64url')}"`,
  ''
].join('\n'), { mode: 0o600, flag: 'wx' });
NODE
fi

bun install --frozen-lockfile
bun run db:generate
mkdir -p db

echo 'Dependencies ready. See docs/codespaces.md to initialize the development database and start the app.'
