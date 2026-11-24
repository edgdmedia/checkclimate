#!/usr/bin/env bash
#
# Nightly backup of the site's SQLite database.
#
# Run it from cron as the `checkclimate` user:
#
#     17 2 * * *  /home/checkclimate/app/scripts/backup-vps.sh >> /home/checkclimate/backups/backup.log 2>&1
#
# The copy is made with SQLite's own backup command, not with `cp`: the
# database runs in WAL mode, so the most recent changes live in the -wal file
# next to it. Copying the .db file alone would lose them, and copying it while
# the site writes can produce a corrupt file.
#
# Local copies are kept for 14 days. The off-site copy goes to the private
# checkclimate-backups bucket; its retention is an R2 lifecycle rule.
set -euo pipefail

DB="${DB:-/home/checkclimate/data/emdash.db}"
BACKUP_DIR="${BACKUP_DIR:-/home/checkclimate/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# Never the media bucket: once media has a public domain, anything in it is
# public. The rclone remote "r2" uses a token scoped to this bucket only, so
# its config needs `no_check_bucket = true` (and `no_head = true`).
OFFSITE="${OFFSITE:-r2:checkclimate-backups}"
STAMP="$(date +%F)"

if ! command -v sqlite3 >/dev/null; then
	echo "backup-vps: the sqlite3 CLI is required" >&2
	exit 1
fi
if [ ! -f "$DB" ]; then
	echo "backup-vps: no database at $DB" >&2
	exit 1
fi

mkdir -p "$BACKUP_DIR"
# `sudo -u checkclimate` from root's shell keeps /root as the working
# directory, which this user cannot read; find would then fail under set -e.
cd "$BACKUP_DIR"
TARGET="$BACKUP_DIR/emdash-$STAMP.db"

echo "backup-vps: $(date '+%F %T') $DB -> $TARGET"
sqlite3 "$DB" ".backup '$TARGET'"

# A backup that cannot be opened is worse than none: it looks like a restore
# point and is not.
integrity=$(sqlite3 "$TARGET" "PRAGMA integrity_check;" || true)
if [ "$integrity" != "ok" ]; then
	echo "backup-vps: the copy failed its integrity check ($integrity); not keeping it" >&2
	rm -f "$TARGET"
	exit 1
fi

if command -v rclone >/dev/null && rclone listremotes 2>/dev/null | grep -qx "${OFFSITE%%:*}:"; then
	rclone copyto "$TARGET" "$OFFSITE/emdash-$STAMP.db"
	echo "backup-vps: copied off-site to $OFFSITE"
else
	# Loud, so cron mail or the log shows it: a box-only backup dies with the box.
	echo "backup-vps: no rclone remote for $OFFSITE; OFF-SITE COPY SKIPPED" >&2
	off_site_missing=1
fi

find "$BACKUP_DIR" -maxdepth 1 -name 'emdash-*.db' -mtime "+$KEEP_DAYS" -print -delete

echo "backup-vps: done ($(du -h "$TARGET" | cut -f1))"
exit "${off_site_missing:-0}"
