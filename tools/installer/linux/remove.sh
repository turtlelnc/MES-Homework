#!/bin/sh
set -eu
if [ "${1:-}" = remove ] || [ "${1:-}" = purge ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop mes-homework.service >/dev/null 2>&1 || true
    systemctl disable mes-homework.service >/dev/null 2>&1 || true
  fi
fi
# Configuration, database, uploads and the service account are deliberately kept.
