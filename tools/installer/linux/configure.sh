#!/bin/sh
set -eu
unset MES_HOMEWORK_CONFIG MES_HOMEWORK_HOME
# Privileged package maintenance must never follow service-controlled links.
for directory in /var/lib/mes-homework /var/lib/mes-homework/data /etc/mes-homework; do
  if [ -L "$directory" ]; then echo "Refusing symlinked service directory: $directory" >&2; exit 1; fi
done
if ! getent passwd mes-homework >/dev/null; then
  if command -v adduser >/dev/null 2>&1 && [ "${MES_PACKAGE_FORMAT:-deb}" = deb ]; then
    adduser --system --group --home /var/lib/mes-homework --no-create-home mes-homework
  else
    useradd --system --user-group --home-dir /var/lib/mes-homework --no-create-home --shell /usr/sbin/nologin mes-homework
  fi
fi
install -d -m 0700 -o mes-homework -g mes-homework /var/lib/mes-homework
install -d -m 0750 -o root -g mes-homework /etc/mes-homework
/opt/mes-homework/runtime/node /opt/mes-homework/app/tools/installer/runtime/launch.mjs --service --prepare
chown root:mes-homework /etc/mes-homework/environment
chmod 0640 /etc/mes-homework/environment
chown --no-dereference mes-homework:mes-homework /var/lib/mes-homework/data
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  if [ -f /run/mes-homework-package-restart ]; then
    systemctl start mes-homework.service
    rm -f /run/mes-homework-package-restart
  fi
fi
# First installation leaves the server disabled. A desktop launch uses private
# per-user data; server hosting is enabled explicitly by the administrator.
