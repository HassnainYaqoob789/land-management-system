#!/usr/bin/env python3
"""Forward-only migration runner for the LMS PostgreSQL schema.

Standard library only (the project's convention, see app/serve.py); it shells
out to psql so no driver has to be installed.

    db/tools/migrate.py status
    db/tools/migrate.py up                 # apply pending migrations
    db/tools/migrate.py up --to 0007       # stop after that version
    db/tools/migrate.py verify             # re-check checksums, apply nothing

Every migration runs inside one transaction together with the bookkeeping row,
so a failed migration leaves no trace and can be fixed and re-run. Checksums
are recorded: editing an applied migration is reported as drift rather than
silently ignored.

Connection comes from the standard libpq environment (PGHOST, PGPORT, PGUSER,
PGPASSWORD, PGDATABASE) or --dsn. Migrations must be run as a role that owns
the schema; see docs/DATABASE_SECURITY_REVIEW.md for the role split.
"""
import argparse
import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATIONS = os.path.join(ROOT, "migrations")
NAME_RE = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")

BOOTSTRAP = """
CREATE SCHEMA IF NOT EXISTS lms_meta AUTHORIZATION lms_owner;
ALTER SCHEMA lms_meta OWNER TO lms_owner;
GRANT USAGE ON SCHEMA lms_meta TO lms_migrator, lms_readonly;
CREATE TABLE IF NOT EXISTS lms_meta.schema_migration (
  version      text        PRIMARY KEY,
  name         text        NOT NULL,
  checksum     text        NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  applied_by   text        NOT NULL DEFAULT current_user,
  duration_ms  integer
);
ALTER TABLE lms_meta.schema_migration OWNER TO lms_owner;
GRANT SELECT, INSERT ON lms_meta.schema_migration TO lms_migrator;
GRANT SELECT ON lms_meta.schema_migration TO lms_readonly;
COMMENT ON TABLE lms_meta.schema_migration IS
  'One row per applied migration. checksum is sha256 of the file as applied; '
  'a mismatch means an applied migration was edited afterwards.';
"""


def psql(sql, dsn=None, quiet=True, tuples_only=True):
    cmd = ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc"]
    if tuples_only:
        cmd += ["-At"]
    if quiet:
        cmd += ["-q"]
    if dsn:
        cmd += ["-d", dsn]
    cmd += ["-c", sql]
    return subprocess.run(cmd, capture_output=True, text=True)


def psql_file(path, dsn=None, extra_sql=""):
    """Run one file plus trailing SQL as a single transaction."""
    with open(path, encoding="utf-8") as fh:
        body = fh.read()
    # Migrations write to audited tables, and the audit trigger refuses an
    # unattributed change. They act as the fixed system service account seeded
    # in migration 0002; the audit row also records the database role, so a
    # migration-time change stays distinguishable from an application one.
    script = (
        "BEGIN;\n"
        "SET LOCAL lms.actor_id = '00000000-0000-0000-0000-000000000001';\n"
        + body + "\n" + extra_sql + "\nCOMMIT;\n"
    )
    cmd = ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q", "-At"]
    if dsn:
        cmd += ["-d", dsn]
    cmd += ["-f", "-"]
    return subprocess.run(cmd, input=script, capture_output=True, text=True)


def discover():
    out = []
    for fn in sorted(os.listdir(MIGRATIONS)):
        m = NAME_RE.match(fn)
        if not m:
            if fn.endswith(".sql"):
                sys.exit(f"migration filename not NNNN_name.sql: {fn}")
            continue
        path = os.path.join(MIGRATIONS, fn)
        with open(path, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        out.append({"version": m.group(1), "name": m.group(2),
                    "file": fn, "path": path, "checksum": digest})
    return out


def applied(dsn):
    r = psql("SELECT version || E'\\t' || checksum FROM lms_meta.schema_migration ORDER BY version;", dsn)
    if r.returncode != 0:
        return {}
    rows = {}
    for line in r.stdout.splitlines():
        if "\t" in line:
            v, c = line.split("\t", 1)
            rows[v] = c
    return rows


def cmd_status(args):
    disk = discover()
    done = applied(args.dsn)
    drift = 0
    print(f"{'ver':<6}{'state':<12}{'name'}")
    for m in disk:
        if m["version"] not in done:
            state = "pending"
        elif done[m["version"]] != m["checksum"]:
            state, drift = "DRIFT", drift + 1
        else:
            state = "applied"
        print(f"{m['version']:<6}{state:<12}{m['name']}")
    orphan = sorted(set(done) - {m["version"] for m in disk})
    for v in orphan:
        print(f"{v:<6}{'ORPHAN':<12}(recorded but no file on disk)")
    print(f"\n{len(disk)} on disk, {len(done)} applied, "
          f"{sum(1 for m in disk if m['version'] not in done)} pending, "
          f"{drift} drifted, {len(orphan)} orphaned")
    return 1 if (drift or orphan) and args.strict else 0


def cmd_verify(args):
    args.strict = True
    return cmd_status(args)


def cmd_up(args):
    r = psql(BOOTSTRAP, args.dsn, tuples_only=False)
    if r.returncode != 0:
        sys.exit("cannot create lms_meta.schema_migration:\n" + r.stderr)
    disk = discover()
    done = applied(args.dsn)
    for m in disk:
        if m["version"] in done:
            if done[m["version"]] != m["checksum"]:
                sys.exit(f"migration {m['version']} was edited after being applied "
                         f"(checksum drift). Add a new migration instead.")
            continue
        if args.to and m["version"] > args.to:
            break
        book = ("RESET ROLE;\nINSERT INTO lms_meta.schema_migration(version,name,checksum,duration_ms) "
                "VALUES (%s,%s,%s,NULL);" % (_lit(m["version"]), _lit(m["name"]), _lit(m["checksum"])))
        print(f"-> {m['file']}", flush=True)
        res = psql_file(m["path"], args.dsn, book)
        if res.returncode != 0:
            sys.stderr.write(res.stdout + res.stderr)
            sys.exit(f"migration {m['version']} failed; nothing was committed")
        if res.stdout.strip():
            print(res.stdout.rstrip())
    print("up to date")
    return 0


def _lit(s):
    return "'" + s.replace("'", "''") + "'"


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["up", "status", "verify"])
    p.add_argument("--dsn", default=os.environ.get("LMS_DSN"))
    p.add_argument("--to", help="highest version to apply")
    p.add_argument("--strict", action="store_true",
                   help="exit non-zero on checksum drift or orphans")
    a = p.parse_args()
    return {"up": cmd_up, "status": cmd_status, "verify": cmd_verify}[a.command](a)


if __name__ == "__main__":
    sys.exit(main())
