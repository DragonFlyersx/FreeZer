#!/usr/bin/env bash
# Start FreeZer. Uses ./.venv if it exists, otherwise the system Python.
set -euo pipefail
cd "$(dirname "$0")"
if [ -x .venv/bin/python ]; then
  exec .venv/bin/python app.py "$@"
fi
exec python3 app.py "$@"
