#!/bin/sh
set -eu
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet mes-homework.service; then
  (umask 077; : > /run/mes-homework-package-restart)
  systemctl stop mes-homework.service
fi
