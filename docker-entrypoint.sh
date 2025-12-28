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

# Install a cron job for Taskwarrior sync.
# Only enable this when the configured taskrc exists AND has an uncommented
# sync configuration (any `sync.*=` setting).
if command -v cron >/dev/null 2>&1 || command -v crond >/dev/null 2>&1; then
	TASKDATA_PATH="${TASKDATA:-/root/.task}"
	TASKRC_PATH="${TASKRC:-/root/.taskrc}"
	TASK_SYNC_LOG="${TASK_SYNC_LOG:-/proc/1/fd/1}"

	has_sync_config=false
	if [ -f "$TASKRC_PATH" ]; then
		if grep -Eq '^[[:space:]]*sync\.[^[:space:]=]+[[:space:]]*=' "$TASKRC_PATH"; then
			has_sync_config=true
		fi
	fi

	if [ "$has_sync_config" = "true" ]; then
		mkdir -p /etc/cron.d
		cat >/etc/cron.d/task-sync <<EOF
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
TASKDATA=$TASKDATA_PATH
TASKRC=$TASKRC_PATH

*/15 * * * * root task sync >>"$TASK_SYNC_LOG" 2>&1
EOF
		chmod 0644 /etc/cron.d/task-sync

		# Start cron in the background.
		if command -v cron >/dev/null 2>&1; then
			cron
		elif command -v crond >/dev/null 2>&1; then
			crond
		fi
	fi
fi

exec "$@"
