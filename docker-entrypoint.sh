#!/bin/sh
set -eu

# Ensure Taskwarrior has a place to store data.
mkdir -p /root/.task

# Taskwarrior's `task config` prompts when adding new keys.
# Instead, generate a minimal rc file from environment at container start.
{
  printf '%s\n' "# Generated at container start"
  printf '%s\n' "data.location=/root/.task"

  if [ -n "${TASK_SYNC_SERVER_URL:-}" ]; then
    printf '%s=%s\n' "sync.server.url" "${TASK_SYNC_SERVER_URL}"
  fi

  if [ -n "${TASK_SYNC_CLIENT_ID:-}" ]; then
    printf '%s=%s\n' "sync.server.client_id" "${TASK_SYNC_CLIENT_ID}"
  fi

  if [ -n "${TASK_SYNC_ENCRYPTION_SECRET:-}" ]; then
    printf '%s=%s\n' "sync.encryption_secret" "${TASK_SYNC_ENCRYPTION_SECRET}"
  fi
} > /root/.taskrc

exec "$@"
