#!/usr/bin/env python3
"""Concurrency tests. Two real sessions, not one session pretending.

Run by db/tools/run_tests.py, which passes the database name in LMS_TEST_DB.
These cannot be written as a single SQL file: every claim here is about what
happens when two transactions interleave, which needs two connections.

What is being proven:

  1. Two simultaneous releases of one voucher produce one payment, not two.
     The second blocks on the row lock, and when the first commits it fails.
  2. Even without the routine, the UNIQUE constraint on payment_release
     refuses the second insert — the guarantee does not depend on the
     application reaching the routine.
  3. Optimistic concurrency: two sessions that both read version N and write
     back cannot both succeed. The loser updates zero rows and knows it.
  4. Two concurrent first-time payment requests for the same payee, category
     and period produce one voucher, not two.
  5. A deadlock is detected and reported rather than hanging.
"""
import os
import subprocess
import sys
import threading
import time

DB = os.environ.get("LMS_TEST_DB", "lms_test")

# These tests commit, so a re-run against a database that was not rebuilt must
# not collide with what the previous run left behind. Every idempotency key and
# every payment period is offset by a per-run number for that reason.
RUN = int(time.time()) % 100000
FAILURES = []
PASSES = []


# -q suppresses the command tags (SET, DO, INSERT 0 1) so that stdout holds
# query results only and scalar() can trust the last line.
def psql(sql, user="lms_test"):
    r = subprocess.run(
        ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q", "-At",
         "-U", user, "-d", DB, "-f", "-"],
        input=sql, capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def ok(cond, label):
    (PASSES if cond else FAILURES).append(label)
    print(f"{'ok  ' if cond else 'FAIL'} {label}")


def scalar(sql, user="lms_migrator"):
    rc, out, err = psql(sql, user)
    if rc != 0:
        raise RuntimeError(err)
    return out.splitlines()[-1] if out else ""


# Each setup needs its own idempotency key, or the second call would be
# treated as a retry of the first and hand back the same voucher.
_SEQ = [0]


def nextkey(stem):
    _SEQ[0] += 1
    return f"{stem}-{RUN}-{_SEQ[0]:04d}-aaaaaaaa"


def nextperiod():
    """A payment period no other run has used, so the duplicate-payment index
    refuses only what this test means it to refuse."""
    _SEQ[0] += 1
    return 1000 + (RUN % 20000) + _SEQ[0]


def setup_voucher():
    """A fresh verified voucher to race over. Returns its id."""
    key = nextkey("conc-req")
    period = nextperiod()
    sql = f"""
    SET ROLE lms_owner;
    SET lms.actor_id = '00000000-0000-0000-0000-000000000001';
    DO $$
    DECLARE v uuid; p uuid; lo uuid; u_fin uuid; u_lo uuid;
    BEGIN
      SELECT id INTO p  FROM lms.project WHERE code = 'DHRK-001';
      SELECT id INTO lo FROM lms.landowner WHERE cnic = '45102-1100012-3';
      SELECT id INTO u_lo  FROM lms.app_user WHERE username = 'lofield';
      SELECT id INTO u_fin FROM lms.app_user WHERE username = 'finance';
      PERFORM api.set_actor(u_lo);
      v := api.request_payment(
        p_idempotency_key => '{key}',
        p_project_id => p, p_category => 'Crop Compensation', p_pay_type => 'One-time',
        p_period_from => current_date + {period}, p_gross_amount => 50000,
        p_payment_mode => 'Cross Cheque', p_landowner_id => lo);
      PERFORM api.set_actor(u_fin);
      PERFORM api.advance_workflow('payments', v, 'Verified');
      RAISE NOTICE 'voucher %', v;
      PERFORM set_config('conc.voucher', v::text, false);
    END $$;
    SELECT current_setting('conc.voucher');
    """
    return scalar(sql)


def race(sql_a, sql_b, user="lms_test"):
    """Run two scripts at the same time; return both results."""
    res = {}

    def go(key, sql):
        res[key] = psql(sql, user)

    ta = threading.Thread(target=go, args=("a", sql_a))
    tb = threading.Thread(target=go, args=("b", sql_b))
    ta.start()
    tb.start()
    ta.join(60)
    tb.join(60)
    return res["a"], res["b"]


def test_double_release():
    pay = setup_voucher()
    key_a, key_b = nextkey("conc-rel-a"), nextkey("conc-rel-b")

    # Session A holds the voucher's row lock for a moment before committing, so
    # that B is certainly inside the same window rather than merely nearby.
    a = f"""
    BEGIN;
    SELECT test.become('mland');
    SELECT api.release_payment('{pay}', '{key_a}');
    SELECT pg_sleep(1.5);
    COMMIT;
    SELECT 'A committed';
    """
    b = f"""
    SELECT pg_sleep(0.3);
    BEGIN;
    SELECT test.become('mland');
    SELECT api.release_payment('{pay}', '{key_b}');
    COMMIT;
    SELECT 'B committed';
    """
    (rc_a, out_a, err_a), (rc_b, out_b, err_b) = race(a, b)

    ok(rc_a == 0, "the first of two concurrent releases succeeds")
    ok(rc_b != 0, "the second of two concurrent releases fails")
    ok("already been released" in err_b or "duplicate key" in err_b,
       f"and fails because the payment was already released (got: {err_b.splitlines()[0] if err_b else 'no error'})")

    n = scalar(f"SET ROLE lms_owner; SELECT count(*) FROM lms.payment_release "
               f"WHERE payment_id = '{pay}'")
    ok(n == "1", "exactly one release row exists for the voucher")
    stage = scalar(f"SET ROLE lms_owner; SELECT stage_code FROM lms.payment_request "
                   f"WHERE id = '{pay}'")
    ok(stage == "Released", "and the voucher is Released once")


def test_constraint_without_routine():
    """The guarantee must not depend on going through the routine."""
    pay = setup_voucher()
    key = nextkey("conc-direct")
    # Release it once properly, then try to insert a second release row as the
    # owner — the role that bypasses every grant and every policy. Only the
    # UNIQUE constraint is left, and it is enough.
    # One transaction: api.set_actor() uses SET LOCAL, so the actor would be
    # gone by the next statement if these ran as separate transactions. That is
    # the pooling-safety property, demonstrated here by having to work with it.
    scalar(f"""
    BEGIN;
    SET ROLE lms_owner;
    SELECT test.become('mland');
    SELECT api.release_payment('{pay}', '{key}');
    COMMIT;
    """)
    rc, out, err = psql(f"""
    SET ROLE lms_owner;
    SET lms.actor_id = '00000000-0000-0000-0000-000000000001';
    ALTER TABLE lms.payment_release DISABLE TRIGGER USER;
    INSERT INTO lms.payment_release
      (payment_id, province_code, cheque_no, released_amount, released_by)
    SELECT '{pay}', 'SND', 'CHQ-RACE-{os.getpid()}', 1,
           (SELECT id FROM lms.app_user WHERE username='mland');
    """, "lms_migrator")
    ok(rc != 0 and "payment_release_payment_id_key" in err,
       "a second release row is refused by UNIQUE(payment_id) even with the triggers off "
       "and the privileges of the schema owner")
    psql("SET ROLE lms_owner; ALTER TABLE lms.payment_release ENABLE TRIGGER USER;",
         "lms_migrator")


def test_optimistic_concurrency():
    """Two editors, one record, last-write-wins is NOT what happens."""
    lo = scalar("SET ROLE lms_owner; SELECT id FROM lms.landowner "
                "WHERE cnic = '45102-1100014-9'")
    ver = scalar(f"SET ROLE lms_owner; SELECT version FROM lms.landowner WHERE id = '{lo}'")

    # Both read version N and both write back WHERE version = N. The row lock
    # serialises them; the second then matches nothing.
    a = f"""
    BEGIN;
    SELECT test.become('lofield');
    UPDATE lms.landowner SET address = 'written by A'
     WHERE id = '{lo}' AND version = {ver};
    SELECT 'A rows=' || (SELECT count(*) FROM lms.landowner
                         WHERE id = '{lo}' AND address = 'written by A');
    SELECT pg_sleep(1.5);
    COMMIT;
    """
    b = f"""
    SELECT pg_sleep(0.3);
    BEGIN;
    SELECT test.become('lofield');
    UPDATE lms.landowner SET address = 'written by B'
     WHERE id = '{lo}' AND version = {ver};
    SELECT 'B updated ' || (SELECT count(*) FROM lms.landowner
                            WHERE id = '{lo}' AND address = 'written by B') || ' rows';
    COMMIT;
    """
    (rc_a, out_a, _), (rc_b, out_b, _) = race(a, b)
    ok(rc_a == 0 and rc_b == 0, "both sessions complete without error")
    ok("B updated 0 rows" in out_b,
       "the second writer's UPDATE ... WHERE version = N matches no row, so it detects the "
       "conflict instead of overwriting the first write")
    addr = scalar(f"SET ROLE lms_owner; SELECT address FROM lms.landowner WHERE id = '{lo}'")
    ok(addr == "written by A", "and the first write survives")
    newver = scalar(f"SET ROLE lms_owner; SELECT version FROM lms.landowner WHERE id = '{lo}'")
    ok(int(newver) == int(ver) + 1, "the version advanced by exactly one, not two")


def test_duplicate_payment_race():
    """Two first-time requests for the same payee, category and period."""
    key_a, key_b = nextkey("conc-dup-a"), nextkey("conc-dup-b")
    period = nextperiod()
    body = """
    SELECT test.become('lofield');
    SELECT api.request_payment(
      p_idempotency_key => '{key}',
      p_project_id => (SELECT id FROM lms.project WHERE code = 'DHRK-001'),
      p_category => 'Tree Compensation', p_pay_type => 'One-time',
      p_period_from => current_date + {period}, p_gross_amount => 7000,
      p_payment_mode => 'Cross Cheque',
      p_landowner_id => (SELECT id FROM lms.landowner WHERE cnic = '45102-1100012-3'));
    """
    a = "BEGIN;\n" + body.format(key=key_a, period=period) + "\nSELECT pg_sleep(1.0);\nCOMMIT;"
    b = ("SELECT pg_sleep(0.2);\nBEGIN;\n" + body.format(key=key_b, period=period)
         + "\nCOMMIT;")
    (rc_a, _, err_a), (rc_b, _, err_b) = race(a, b)
    ok((rc_a == 0) != (rc_b == 0),
       "exactly one of two concurrent duplicate requests succeeds "
       f"(a={rc_a} b={rc_b}; a_err={err_a.splitlines()[0] if err_a else '-'}; "
       f"b_err={err_b.splitlines()[0] if err_b else '-'})")
    loser = err_a if rc_a != 0 else err_b
    ok("payment_no_duplicate_live_uq" in loser or "duplicate key" in loser,
       "and the other is refused by the duplicate-payment unique index")
    n = scalar(f"SET ROLE lms_owner; SELECT count(*) FROM lms.payment_request "
               f"WHERE category_code = 'Tree Compensation' "
               f"AND period_from = current_date + {period}")
    ok(n == "1", "leaving exactly one voucher")


def test_deadlock_is_detected():
    """Two sessions locking two rows in opposite orders."""
    ids = scalar("SET ROLE lms_owner; SELECT string_agg(id::text, ',') FROM "
                 "(SELECT id FROM lms.landowner WHERE province_code='SND' "
                 " ORDER BY code LIMIT 2) t").split(",")
    x, y = ids[0], ids[1]
    a = f"""
    BEGIN;
    SELECT test.become('lofield');
    UPDATE lms.landowner SET phone = 'A1' WHERE id = '{x}';
    SELECT pg_sleep(0.6);
    UPDATE lms.landowner SET phone = 'A2' WHERE id = '{y}';
    COMMIT;
    """
    b = f"""
    BEGIN;
    SELECT test.become('lofield');
    UPDATE lms.landowner SET phone = 'B1' WHERE id = '{y}';
    SELECT pg_sleep(0.6);
    UPDATE lms.landowner SET phone = 'B2' WHERE id = '{x}';
    COMMIT;
    """
    (rc_a, _, err_a), (rc_b, _, err_b) = race(a, b)
    both = err_a + err_b
    ok((rc_a == 0) != (rc_b == 0), "a deadlock resolves: one session completes, one is aborted")
    ok("deadlock detected" in both,
       "and the aborted session is told it was a deadlock, so a client can retry it")


if __name__ == "__main__":
    for fn in (test_double_release, test_constraint_without_routine,
               test_optimistic_concurrency, test_duplicate_payment_race,
               test_deadlock_is_detected):
        try:
            fn()
        except Exception as exc:                      # noqa: BLE001
            ok(False, f"{fn.__name__} raised: {exc}")
    print(f"\n{len(PASSES)} passed, {len(FAILURES)} failed")
    sys.exit(1 if FAILURES else 0)
