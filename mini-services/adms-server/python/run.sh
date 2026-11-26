#!/usr/bin/env bash
#
# aogc-bicms-adms convenience launcher (development and sandbox runs).
# Production deployments run under systemd instead -- see
# deploy/adms/README.md and deploy/adms/aogc-bicms-adms.service.
#
# Uses the system python3 when fastapi+uvicorn are already importable;
# otherwise bootstraps a local .venv from requirements.lock.
#
# Sandbox example:
#   BICMS_ADMS_DATA_DIR=./tmp-data \
#   BICMS_ADMS_PORTS='{"device":18081,"internalApi":18082,"httpsApi":18443}' \
#   bash run.sh

set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${BICMS_ADMS_PYTHON:-python3}"

if "$PYTHON" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
    exec "$PYTHON" bicms_adms.py "$@"
fi

VENV_DIR="${BICMS_ADMS_VENV_DIR:-.venv}"
if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "[run.sh] fastapi/uvicorn not importable with $PYTHON; bootstrapping $VENV_DIR"
    "$PYTHON" -m venv "$VENV_DIR"
    "$VENV_DIR/bin/python" -m pip install --upgrade pip
    "$VENV_DIR/bin/python" -m pip install -r requirements.lock
fi
exec "$VENV_DIR/bin/python" bicms_adms.py "$@"
