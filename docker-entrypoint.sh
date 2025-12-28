#!/bin/sh
set -eu

# If tzdata is installed, keep /etc/localtime and /etc/timezone in sync with $TZ.
# This makes Taskwarrior's date parsing (e.g. due:eoy) deterministic.
if [ -n "${TZ:-}" ]; then
	if [ -e "/usr/share/zoneinfo/$TZ" ]; then
		ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
		printf '%s' "$TZ" >/etc/timezone
	fi
fi

exec "$@"
