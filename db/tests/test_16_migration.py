#!/usr/bin/env python3
"""Migration behaviour: against a clean database, against an existing one, and
against tampering with an already-applied migration.

Run by db/tools/run_tests.py. It creates and drops its own scratch databases,
named lms_mtest_* so they cannot collide with lms_dev, lms_test or lms_perf.

What is being proven:

  1. Every migration applies to an empty database, in order, and the result is
     recorded with a checksum.
  2. Running `up` again is a no-op rather than an error, so a deploy that
     re-runs the step is harmless.
  3. Applying in two halves reaches the same schema as applying in one go —
     which is what "migrate an existing database" means in practice.
  4. Editing a migration after it has been applied is reported as drift and
     refused, rather than being silently ignored or silently re-run.
  5. A failing migration commits nothing, so the database is left where it was
     and the fix can be re-run.
"""
import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIG = os.path.join(ROOT, "migrations")
TOOLS = os.path.join(ROOT, "tools")
PASSES, FAILURES = [], []


def ok(cond, label):
    (PASSES if cond else FAILURES).append(label)
    print(f"{'ok  ' if cond else 'FAIL'} {label}")


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def psql(db, sql, user="lms_migrator"):
    return sh(["psql", "-q", "-At", "--no-psqlrc", "-U", user, "-d", db, "-c", sql])


def make_db(name):
    sh(["psql", "-q", "-d", "postgres", "-c",
        f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        f"WHERE datname='{name}' AND pid <> pg_backend_pid()"])
    sh(["psql", "-q", "-d", "postgres", "-c", f"DROP DATABASE IF EXISTS {name}"])
    r = sh(["psql", "-q", "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-v", f"db={name}",
            "-f", os.path.join(ROOT, "bootstrap", "02_database.sql")])
    if r.returncode != 0:
        raise RuntimeError(r.stderr)


def drop_db(name):
    sh(["psql", "-q", "-d", "postgres", "-c",
        f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        f"WHERE datname='{name}' AND pid <> pg_backend_pid()"])
    sh(["psql", "-q", "-d", "postgres", "-c", f"DROP DATABASE IF EXISTS {name}"])


def migrate(db, *extra):
    env = dict(os.environ, LMS_DSN=f"postgresql:///{db}?user=lms_migrator")
    return sh([sys.executable, os.path.join(TOOLS, "migrate.py"), "up", *extra], env=env)


def status(db, *extra):
    env = dict(os.environ, LMS_DSN=f"postgresql:///{db}?user=lms_migrator")
    return sh([sys.executable, os.path.join(TOOLS, "migrate.py"), *extra], env=env)


def schema_fingerprint(db):
    """Everything that defines the schema, in a stable order: columns with
    their types and defaults, constraints, indexes, triggers, policies and
    routine signatures. Two databases with the same fingerprint have the same
    schema whatever order it was built in."""
    sql = r"""
    SET ROLE lms_owner;
    WITH parts AS (
      SELECT 'col ' || table_schema||'.'||table_name||'.'||column_name||' '||
             data_type||' '||coalesce(numeric_precision::text,'')||','||
             coalesce(numeric_scale::text,'')||' null='||is_nullable||
             ' def='||coalesce(column_default,'-')||' gen='||coalesce(is_generated,'-') AS p
      FROM information_schema.columns
      WHERE table_schema IN ('lms','api','audit','util')
      UNION ALL
      SELECT 'con ' || n.nspname||'.'||rel.relname||'.'||c.conname||' '||c.contype::text||' '||
             pg_get_constraintdef(c.oid)
      FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=rel.relnamespace
      WHERE n.nspname IN ('lms','api','audit','util')
      UNION ALL
      SELECT 'idx ' || schemaname||'.'||indexname||' '||indexdef
      FROM pg_indexes WHERE schemaname IN ('lms','api','audit','util')
      UNION ALL
      SELECT 'trg ' || n.nspname||'.'||rel.relname||'.'||t.tgname||' '||
             t.tgtype::text||' deferrable='||t.tgdeferrable::text||
             ' initdeferred='||t.tginitdeferred::text
      FROM pg_trigger t JOIN pg_class rel ON rel.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=rel.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname IN ('lms','api','audit','util')
      UNION ALL
      SELECT 'pol ' || schemaname||'.'||tablename||'.'||policyname||' '||
             coalesce(qual,'-')||' / '||coalesce(with_check,'-')
      FROM pg_policies WHERE schemaname IN ('lms','api','audit','util')
      UNION ALL
      SELECT 'fun ' || n.nspname||'.'||p.proname||'('||
             pg_get_function_identity_arguments(p.oid)||') secdef='||p.prosecdef::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('lms','api','audit','util')
      UNION ALL
      SELECT 'viw ' || schemaname||'.'||viewname||' '||md5(definition)
      FROM pg_views WHERE schemaname IN ('lms','api','audit','util')
    )
    SELECT md5(string_agg(p, E'\n' ORDER BY p)) FROM parts;
    """
    r = psql(db, sql)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout.strip().splitlines()[-1]


def test_clean_database():
    db = "lms_mtest_clean"
    try:
        make_db(db)
        r = migrate(db)
        ok(r.returncode == 0, "every migration applies to a clean database")
        applied = psql(db, "SELECT count(*) FROM lms_meta.schema_migration").stdout.strip()
        files = len([f for f in os.listdir(MIG) if re.match(r"^\d{4}_.*\.sql$", f)])
        ok(applied == str(files),
           f"all {files} migrations are recorded as applied")
        ok(psql(db, "SELECT count(*) FROM lms_meta.schema_migration "
                    "WHERE checksum IS NULL OR length(checksum) <> 64").stdout.strip() == "0",
           "each one recorded with a sha256 checksum")

        # Reference data is present, demo data is not: a migration must never
        # load fictional records into a database that might be production.
        ok(psql(db, "SET ROLE lms_owner; SELECT count(*) FROM lms.province").stdout.strip() == "4",
           "the four provinces are present as reference data")
        ok(psql(db, "SET ROLE lms_owner; SELECT count(*) FROM lms.workflow").stdout.strip() == "9",
           "and the nine workflow definitions")
        ok(psql(db, "SET ROLE lms_owner; SELECT count(*) FROM lms.landowner").stdout.strip() == "0",
           "and no landowner — migrations load no demo data")
        ok(psql(db, "SET ROLE lms_owner; SELECT count(*) FROM lms.app_user").stdout.strip() == "1",
           "and only the system service account exists");

        r2 = migrate(db)
        ok(r2.returncode == 0 and "up to date" in r2.stdout,
           "running the migration step again is a no-op, not an error")
        ok(status(db, "verify", "--strict").returncode == 0,
           "and verify reports no drift")
        return schema_fingerprint(db)
    finally:
        pass  # kept for the comparison below; dropped by the caller


def test_existing_database(clean_fingerprint):
    """Half now, half later: the realistic case of migrating a database that is
    already in service."""
    db = "lms_mtest_existing"
    try:
        make_db(db)
        r = migrate(db, "--to", "0009")
        ok(r.returncode == 0, "the first nine migrations apply on their own")
        ok(psql(db, "SELECT count(*) FROM lms_meta.schema_migration").stdout.strip() == "9",
           "and nine are recorded")

        # Put data in, as a database in service would have.
        seeded = psql(db, """
          SET ROLE lms_owner;
          SET lms.actor_id = '00000000-0000-0000-0000-000000000001';
          INSERT INTO lms.province (code,name,revenue_key_label,display_order)
          VALUES ('TST','Test Province','Survey No.',9)
          ON CONFLICT DO NOTHING;
          INSERT INTO lms.province_level (province_code,depth,name) VALUES ('TST',0,'District');
          INSERT INTO lms.admin_unit (code,province_code,level,name)
          VALUES ('TST-D-001','TST',0,'Existing District');
          SELECT count(*) FROM lms.admin_unit;
        """)
        ok(seeded.returncode == 0 and seeded.stdout.strip().endswith("1"),
           "data can be written at that intermediate version")

        r = migrate(db)
        ok(r.returncode == 0,
           "the remaining migrations apply to a database that already holds data")
        ok(psql(db, "SET ROLE lms_owner; SELECT count(*) FROM lms.admin_unit "
                    "WHERE code='TST-D-001'").stdout.strip() == "1",
           "and the existing row survives, untouched")

        ok(schema_fingerprint(db) == clean_fingerprint,
           "the resulting schema is identical to the one built in a single pass "
           "— same columns, constraints, indexes, triggers, policies, views and routines")
    finally:
        drop_db(db)


def test_drift_is_refused():
    db = "lms_mtest_drift"
    target = os.path.join(MIG, "0015_reference_data.sql")
    original = open(target, "rb").read()
    try:
        make_db(db)
        ok(migrate(db).returncode == 0, "the suite applies cleanly before the edit")

        # Edit an applied migration, the way a well-meant "small fix" would.
        with open(target, "ab") as fh:
            fh.write(b"\n-- an edit made after this migration was applied\n")

        r = migrate(db)
        ok(r.returncode != 0 and "drift" in (r.stdout + r.stderr),
           "editing an applied migration is refused as checksum drift, not silently ignored")
        r = status(db, "verify", "--strict")
        ok(r.returncode != 0 and "DRIFT" in r.stdout,
           "and verify reports which migration drifted")
    finally:
        with open(target, "wb") as fh:
            fh.write(original)
        drop_db(db)


def test_failure_commits_nothing():
    db = "lms_mtest_fail"
    bad = os.path.join(MIG, "9999_deliberately_broken.sql")
    try:
        make_db(db)
        ok(migrate(db).returncode == 0, "the suite applies cleanly first")
        before = psql(db, "SELECT count(*) FROM lms_meta.schema_migration").stdout.strip()

        # A migration that does something valid and then something impossible.
        with open(bad, "w") as fh:
            fh.write(
                "SET ROLE lms_owner;\n"
                "CREATE TABLE lms.half_applied (id int primary key);\n"
                "SELECT 1 / 0;  -- and now fail\n")
        r = migrate(db)
        ok(r.returncode != 0, "a failing migration reports failure")
        ok(psql(db, "SET ROLE lms_owner; SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema='lms' AND table_name='half_applied'"
                    ).stdout.strip() == "0",
           "and commits nothing: the table it created before failing is not there")
        ok(psql(db, "SELECT count(*) FROM lms_meta.schema_migration").stdout.strip() == before,
           "and is not recorded as applied, so the fix can simply be re-run")

        # Fix it and re-run.
        with open(bad, "w") as fh:
            fh.write("SET ROLE lms_owner;\nCREATE TABLE lms.half_applied (id int primary key);\n")
        ok(migrate(db).returncode == 0, "the corrected migration applies")
        ok(psql(db, "SET ROLE lms_owner; SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema='lms' AND table_name='half_applied'"
                    ).stdout.strip() == "1",
           "and its effect is there")
    finally:
        if os.path.exists(bad):
            os.remove(bad)
        drop_db(db)


if __name__ == "__main__":
    fp = None
    try:
        fp = test_clean_database()
    except Exception as exc:                          # noqa: BLE001
        ok(False, f"test_clean_database raised: {exc}")
    for fn, arg in ((test_existing_database, fp), (test_drift_is_refused, None),
                    (test_failure_commits_nothing, None)):
        try:
            fn(arg) if arg is not None or fn is test_existing_database else fn()
        except Exception as exc:                      # noqa: BLE001
            ok(False, f"{fn.__name__} raised: {exc}")
    drop_db("lms_mtest_clean")
    print(f"\n{len(PASSES)} passed, {len(FAILURES)} failed")
    sys.exit(1 if FAILURES else 0)
