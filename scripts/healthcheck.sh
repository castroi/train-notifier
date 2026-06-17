#!/bin/sh
# healthcheck.sh — Docker HEALTHCHECK for train-notifier
#
# Reads the heartbeat file written by src/health/heartbeat.ts.
# The file contains epoch milliseconds as a plain UTF-8 string.
# Exits 0 (healthy) if the recorded timestamp is less than 120 s old.
# Exits 1 (unhealthy) if the file is missing, empty, non-numeric, or stale.

HEARTBEAT="${HEARTBEAT_PATH:-/run/heartbeat}"
MAX_AGE_MS=120000

# --- file must exist and be readable ---
if [ ! -r "$HEARTBEAT" ]; then
  echo "heartbeat: file missing or unreadable: $HEARTBEAT" >&2
  exit 1
fi

# --- read the epoch-milliseconds value ---
raw=$(cat "$HEARTBEAT")

# --- must be a non-empty sequence of digits ---
case "$raw" in
  ''|*[!0-9]*)
    echo "heartbeat: unexpected contents: $raw" >&2
    exit 1
    ;;
esac

# --- compute age in milliseconds using POSIX date (seconds) ---
# The heartbeat value is in ms; convert to whole seconds for comparison.
beat_s=$(( raw / 1000 ))
now_s=$(date +%s)
age_ms=$(( (now_s - beat_s) * 1000 ))

if [ "$age_ms" -lt "$MAX_AGE_MS" ]; then
  exit 0
else
  echo "heartbeat: stale by $(( age_ms / 1000 ))s (max $(( MAX_AGE_MS / 1000 ))s)" >&2
  exit 1
fi
