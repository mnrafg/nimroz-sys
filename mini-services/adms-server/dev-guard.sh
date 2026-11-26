#!/usr/bin/env bash
#
# Guarded launcher for the aogc-bicms-adms runtime.
#
# Starts the dedicated Python ADMS service ONLY when its loopback
# application-facing API port (127.0.0.1:18082) is not already serving.
# This makes the launcher safe to run from BOTH startup paths:
#   • the platform mini-service discovery (`bun run dev` in this dir)
#   • the Next.js dev instrumentation autostart (next-server child)
# without ever double-binding the listeners.
#
# Production deployments do not use this launcher — systemd owns the
# runtime there (deploy/adms/aogc-bicms-adms.service).
set -euo pipefail
cd "$(dirname "$0")"

if (exec 3<>/dev/tcp/127.0.0.1/18082) 2>/dev/null; then
    exec 3<&- 3>&- || true
    echo "[adms-server] 127.0.0.1:18082 already serving — runtime already running, nothing to start."
    exit 0
fi

echo "[adms-server] port 18082 free — starting runtime via python/run.sh"
exec bash python/run.sh
