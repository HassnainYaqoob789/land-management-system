#!/bin/sh
# =====================================================================
# Backup, restore and restore-verification for the LMS database.
# =====================================================================
# Three commands, and the third is the one that matters:
#
#   db/tools/backup.sh dump    [db] [dir]   take a backup
#   db/tools/backup.sh restore <file> <db>  restore one into a named database
#   db/tools/backup.sh verify  [db] [dir]   dump, restore into a scratch
#                                           database, and compare the two
#
# "verify" is what turns a backup procedure into a tested one. It restores into
# a throwaway database and checks that the row counts, the financial totals,
# the schema fingerprint and the audit trail all match the source. A dump file
# that exists is not a backup; a dump that has been restored and compared is.
#
# Format: pg_dump -Fc (custom), which is compressed, allows a selective
# restore, and can be restored in parallel. Globals (roles) are dumped
# separately by pg_dumpall --globals-only, because roles are cluster-wide and
# a database dump does not contain them — restoring into a fresh cluster needs
# both.
#
# NOT included here, because they are deployment concerns this environment
# cannot provide and must not pretend to: off-site copies, encryption at rest
# for the dump files, retention enforcement, and point-in-time recovery via WAL
# archiving. See docs/DATABASE_ENGINEERING_REPORT.md, "Backup and recovery",
# for what remains to be set up and what the untested RPO/RTO targets are.
set -e

CMD="${1:-verify}"
DB="${2:-lms_dev}"
DIR="${3:-$(cd "$(dirname "$0")/../.." && pwd)/backups}"
STAMP=$(date +%Y%m%d-%H%M%S)

counts_sql() {
  cat <<'SQL'
SET ROLE lms_owner;
SELECT 'rows:' || n.nspname || '.' || c.relname || '=' ||
       (SELECT count(*) FROM pg_catalog.pg_class x WHERE x.oid = c.oid)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE false;
SQL
}

fingerprint() {
  # Row counts for every table, the financial totals, and a schema hash.
  # Dynamic SQL because the table list is whatever the schema holds.
  # search_path is pinned to pg_catalog on purpose: pg_get_constraintdef()
  # renders a referenced table unqualified when its schema is on the path and
  # fully qualified when it is not, so a fingerprint taken with the default
  # path would differ between a migrated database and a restored one for no
  # real reason. Pinning it makes the comparison about the schema itself.
  psql -q -At -U lms_migrator -d "$1" <<'SQL'
SET search_path = pg_catalog;
SET ROLE lms_owner;
DO $$
DECLARE r record; v_out text := ''; v_n bigint;
BEGIN
  FOR r IN SELECT n.nspname AS s, c.relname AS t
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname IN ('lms','audit','lms_meta') AND c.relkind = 'r'
           ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', r.s, r.t) INTO v_n;
    v_out := v_out || r.s || '.' || r.t || '=' || v_n || E'\n';
  END LOOP;
  CREATE TEMP TABLE _fp (part text, value text);
  INSERT INTO _fp VALUES ('rowcounts', md5(v_out)), ('rowcounts_detail', v_out);
END $$;
SELECT part || '|' || value FROM _fp WHERE part = 'rowcounts';
-- The money, checked independently of the row counts: a restore that loses a
-- release row would change both, but a restore that silently truncated a
-- numeric would change only this.
SELECT 'released_total|' || coalesce(sum(released_amount), 0)::text FROM lms.payment_release;
SELECT 'approved_total|' || coalesce(sum(total_amount), 0)::text FROM lms.compensation_case;
SELECT 'allocated_total|' || coalesce(sum(amount), 0)::text FROM lms.payment_allocation;
SELECT 'cheque_numbers|' || coalesce(md5(string_agg(cheque_no, ',' ORDER BY cheque_no)), '-')
  FROM lms.payment_release;
SELECT 'audit_span|' || coalesce(min(occurred_at)::text, '-') || '..' ||
       coalesce(max(occurred_at)::text, '-') || '|' || count(*)::text
  FROM audit.audit_event;
SELECT 'schema|' || md5(string_agg(p, E'\n' ORDER BY p)) FROM (
  SELECT table_schema||'.'||table_name||'.'||column_name||' '||data_type AS p
  FROM information_schema.columns WHERE table_schema IN ('lms','api','audit','util')
  UNION ALL
  SELECT 'c:'||conname||' '||pg_get_constraintdef(oid) FROM pg_constraint
  WHERE connamespace IN ('lms'::regnamespace,'audit'::regnamespace)
  UNION ALL
  SELECT 'i:'||indexname||' '||indexdef FROM pg_indexes
  WHERE schemaname IN ('lms','api','audit','util')
) q;
SELECT 'migrations|' || coalesce(md5(string_agg(version||':'||checksum, ',' ORDER BY version)), '-')
  FROM lms_meta.schema_migration;
SQL
}

case "$CMD" in
  dump)
    mkdir -p "$DIR"
    echo "dumping $DB -> $DIR"
    pg_dump -Fc -Z6 -U lms_migrator -d "$DB" -f "$DIR/$DB-$STAMP.dump"
    pg_dumpall --globals-only -f "$DIR/globals-$STAMP.sql"
    ls -lh "$DIR/$DB-$STAMP.dump" "$DIR/globals-$STAMP.sql"
    echo "ok: $DIR/$DB-$STAMP.dump"
    ;;

  restore)
    FILE="$2"; TARGET="$3"
    [ -n "$FILE" ] && [ -n "$TARGET" ] || { echo "usage: backup.sh restore <file> <db>" >&2; exit 2; }
    echo "restoring $FILE -> $TARGET"
    psql -q -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname='$TARGET' AND pid <> pg_backend_pid()" >/dev/null
    psql -q -d postgres -c "DROP DATABASE IF EXISTS $TARGET"
    psql -q -d postgres -c "CREATE DATABASE $TARGET OWNER lms_owner"
    # --no-owner is NOT used: object ownership is part of the security design
    # (lms_owner owns everything, the app owns nothing), so a restore that
    # reassigned ownership would quietly disable row-level security.
    pg_restore -U lms_migrator -d "$TARGET" --exit-on-error -j4 "$FILE"
    # A single-database dump does not carry database-level settings, so the
    # search_path that migration 0001 sets is lost on restore. Nothing depends
    # on it for correctness — every routine pins its own — but an interactive
    # session would otherwise have to schema-qualify everything, so it is put
    # back here as part of the documented restore procedure.
    psql -q -d "$TARGET" -c "ALTER DATABASE \"$TARGET\" SET search_path = lms, api, audit, ext, public"
    echo "ok: restored into $TARGET"
    ;;

  verify)
    mkdir -p "$DIR"
    SCRATCH="${DB}_restorecheck"
    FILE="$DIR/$DB-$STAMP.dump"
    echo "1. dumping $DB"
    pg_dump -Fc -Z6 -U lms_migrator -d "$DB" -f "$FILE"
    echo "   $(ls -lh "$FILE" | awk '{print $5}')"

    echo "2. recording the source fingerprint"
    fingerprint "$DB" | sort > "$DIR/fp-source-$STAMP.txt"

    echo "3. restoring into $SCRATCH"
    psql -q -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname='$SCRATCH' AND pid <> pg_backend_pid()" >/dev/null
    psql -q -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH"
    psql -q -d postgres -c "CREATE DATABASE $SCRATCH OWNER lms_owner"
    pg_restore -U lms_migrator -d "$SCRATCH" --exit-on-error -j4 "$FILE"
    psql -q -d "$SCRATCH" -c "ALTER DATABASE \"$SCRATCH\" SET search_path = lms, api, audit, ext, public"

    echo "4. recording the restored fingerprint"
    fingerprint "$SCRATCH" | sort > "$DIR/fp-restored-$STAMP.txt"

    echo "5. comparing"
    if diff -u "$DIR/fp-source-$STAMP.txt" "$DIR/fp-restored-$STAMP.txt"; then
      echo
      echo "RESTORE VERIFIED: row counts, financial totals, cheque numbers,"
      echo "audit span, schema and migration history all match."
      echo "  dump:    $FILE"
      echo "  scratch: $SCRATCH (drop it when you are done looking)"
      exit 0
    else
      echo
      echo "RESTORE MISMATCH — the differences are above. Do not treat this"
      echo "dump as a usable backup." >&2
      exit 1
    fi
    ;;

  *)
    echo "usage: backup.sh {dump|restore|verify} …" >&2
    exit 2
    ;;
esac
