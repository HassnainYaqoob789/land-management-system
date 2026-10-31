#!/usr/bin/env python3
"""0041 across logins: who may assert an identity, and what a forged one buys.

Run by db/tools/run_tests.py against lms_test. Every check runs in its own
session and transaction and rolls back, so nothing is left behind.

What is being proven:

  1. A reporting login (lms_report) cannot assert any actor: a raw
     set_config('lms.actor_id', <administrator>) gives it no rows and no tier,
     and it can no longer call api.set_actor.
  2. The application login (lms_app) cannot assume the system account, by the
     routine or by the raw parameter; an owner session can (maintenance).
  3. The database tier follows IAM live: an expired grant confers nothing.
  4. Adding a permission to a role is refused when a current holder would end
     up with a pair the separation-of-duties rules forbid.
  5. Directory provisioning applies group mappings in a signed system context
     and leaves the caller's actor as it found it.
  6. The integration worker's routines are refused to the application and
     work for an owner (maintenance) session.
"""
import os
import subprocess
import sys

DB = os.environ.get("LMS_TEST_DB", "lms_test")
SYSTEM = "00000000-0000-0000-0000-000000000001"
PASSES, FAILURES = [], []


def ok(cond, label):
    (PASSES if cond else FAILURES).append(label)
    print(f"{'ok  ' if cond else 'FAIL'} {label}")


def psql(user, sql):
    """Run one script in one session, wrapped in a transaction that rolls back."""
    script = "\\set ON_ERROR_STOP 1\nBEGIN;\n" + sql + "\nROLLBACK;\n"
    return subprocess.run(["psql", "-X", "-q", "-At", "-U", user, "-d", DB],
                          input=script, capture_output=True, text=True)


def val(user, sql):
    r = psql(user, sql)
    if r.returncode != 0:
        return "ERROR: " + r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "ERROR"
    lines = [x for x in r.stdout.strip().splitlines() if x.strip()]
    return lines[-1] if lines else ""


def admin_id():
    return val("lms_migrator", "SET ROLE lms_owner; SELECT id FROM lms.app_user WHERE username = 'admin';")


def test_reporting_login(admin):
    ok(val("lms_report", f"SELECT set_config('lms.actor_id', '{admin}', true); SELECT coalesce(util.actor_id()::text, 'none');") == "none",
       "a reporting login's asserted actor is ignored")
    ok(val("lms_report", f"SELECT set_config('lms.actor_id', '{admin}', true); "
                         "SELECT count(*) FROM lms.payment_request;") == "0",
       "so even posing as an administrator it reads no vouchers")
    ok(val("lms_report", f"SELECT set_config('lms.actor_id', '{SYSTEM}', true); SELECT coalesce(lms.actor_role(), 'none');") == "none",
       "nor gets a database tier from the system account")
    ok(val("lms_report", f"SELECT api.set_actor('{admin}');").startswith("ERROR"),
       "and it can no longer call api.set_actor")


def test_application_login(admin):
    ok(val("lms_app", f"SELECT api.set_actor('{SYSTEM}');").startswith("ERROR"),
       "the application cannot make the system account its actor")
    ok(val("lms_app", f"SELECT set_config('lms.actor_id', '{SYSTEM}', true); SELECT coalesce(lms.actor_role(), 'none');") == "none",
       "nor gain its Admin tier through the raw parameter")
    ok(val("lms_app", f"SELECT set_config('lms.actor_id', '{SYSTEM}', true); SELECT count(*) FROM lms.payment_request;") == "0",
       "so the raw parameter shows it no vouchers")
    ok(val("lms_app", f"SELECT api.set_actor('{admin}'); SELECT lms.actor_role();") == "Admin",
       "an ordinary application actor still works (the administrator's tier comes from its role)")
    ok(val("lms_migrator", f"SET ROLE lms_owner; SELECT set_config('lms.actor_id', '{SYSTEM}', true); SELECT lms.actor_role();") == "Admin",
       "an owner (maintenance) session may act as the system account")
    ok(val("lms_migrator", f"SET ROLE lms_owner; SELECT set_config('lms.actor_id', '{SYSTEM}', true); SELECT iam.is_system_actor();") == "t",
       "and is recognised as the system actor")


def test_tier_follows_expiry():
    # Owner session: the guard refuses an already-expired grant, so it is
    # switched off for the insert (inside a transaction that rolls back).
    common = ("SET ROLE lms_owner; "
              f"SELECT set_config('lms.actor_id', '{SYSTEM}', true); "
              "ALTER TABLE iam.user_role DISABLE TRIGGER user_role_guard; "
              "ALTER TABLE iam.user_role DISABLE TRIGGER user_role_after; ")
    grant = ("INSERT INTO iam.user_role (user_id, role_id, reason, granted_by, granted_at, expires_at) "
             "SELECT u.id, r.id, 'expired grant', u.id, now() - interval '10 days', {exp} "
             "FROM lms.app_user u, iam.role r WHERE u.username = 'viewer' AND r.code = 'land-manager'; ")
    probe = ("SELECT set_config('lms.actor_id', (SELECT id::text FROM lms.app_user WHERE username = 'viewer'), true); "
             "SELECT lms.actor_role();")
    ok(val("lms_migrator", common + grant.format(exp="now() - interval '1 day'") + probe) == "Viewer",
       "an expired grant gives no tier (the account stays a Viewer)")
    ok(val("lms_migrator", common + grant.format(exp="now() + interval '1 day'") + probe) == "Approver",
       "the same grant before it expires gives its tier")


def test_holder_separation_of_duties():
    sql = ("SET ROLE lms_owner; "
           f"SELECT set_config('lms.actor_id', '{SYSTEM}', true); "
           "INSERT INTO iam.role (code, name, description, db_role_code) VALUES ('t19-sod', 'T19 SoD', 'holder SoD test', 'User'); "
           "INSERT INTO iam.role_permission (role_id, permission_id, scope_level) "
           "  SELECT r.id, p.id, 'global' FROM iam.role r, iam.permission p WHERE r.code = 't19-sod' AND p.resource = 'payments' AND p.action = 'read'; "
           "INSERT INTO iam.user_role (user_id, role_id, reason) "
           "  SELECT u.id, r.id, 'holder' FROM lms.app_user u, iam.role r WHERE u.username = 'finance' AND r.code = 't19-sod'; "
           "INSERT INTO iam.role_permission (role_id, permission_id, scope_level) "
           "  SELECT r.id, p.id, 'global' FROM iam.role r, iam.permission p WHERE r.code = 't19-sod' AND p.resource = 'payments' AND p.action = 'release';")
    r = psql("lms_migrator", sql)
    ok(r.returncode != 0 and "separation of duties" in r.stderr,
       "adding release to a role held by the verifier is refused (separation of duties)")


def test_provisioning_context():
    sql = ("SELECT test.become('admin'); "
           "INSERT INTO iam.auth_provider (kind, name, display_name, config) VALUES ('oidc', 't19-oidc', 'T19', '{}'); "
           "INSERT INTO iam.group_mapping (provider_id, external_group, role_id) "
           "  SELECT p.id, 'T19-Readers', r.id FROM iam.auth_provider p, iam.role r WHERE p.name = 't19-oidc' AND r.code = 'viewer'; "
           "SELECT iam.set_policy('iam.provisioning_mode', '\"auto\"'::jsonb, 'provisioning test'); "
           # The application knows the provider's id before sign-in; without an
           # actor the provider row itself is hidden by row-level security.
           "SELECT id AS pid FROM iam.auth_provider WHERE name = 't19-oidc' \\gset\n"
           "SELECT test.unbecome(); "
           "SELECT (iam.provision_external(:'pid', 'subject-t19', 'https://idp.test', "
           "        'ext.t19@example.test', true, 'T19 External', '{T19-Readers}')).status; "
           "SELECT coalesce(util.actor_id()::text, 'none'); "
           "SELECT test.become('admin'); "
           "SELECT r.code || '/' || (ur.granted_by = '00000000-0000-0000-0000-000000000001') FROM iam.user_role ur "
           "  JOIN iam.role r ON r.id = ur.role_id JOIN iam.external_identity e ON e.user_id = ur.user_id "
           " WHERE e.subject = 'subject-t19' AND ur.revoked_at IS NULL;")
    r = psql("lms_test", sql)
    out = [x for x in r.stdout.strip().splitlines() if x.strip()]
    ok(r.returncode == 0 and "ok" in out, "directory provisioning creates the account"
       + ("" if r.returncode == 0 else f" (error: {r.stderr.strip()[-300:]})"))
    ok(r.returncode == 0 and "none" in out, "and leaves the caller without an actor, as it found it")
    ok(r.returncode == 0 and out and out[-1] == "viewer/true", "the mapped role is granted, attributed to the system account")


def test_worker_routines():
    ok(val("lms_app", "SELECT count(*) FROM api.outbox_next('erp_finance');").startswith("ERROR"),
       "the application cannot read the integration outbox")
    ok(not val("lms_migrator", "SET ROLE lms_owner; SELECT count(*) FROM api.outbox_next('erp_finance');").startswith("ERROR"),
       "an owner (maintenance) session can")


if __name__ == "__main__":
    a = admin_id()
    for fn, args in ((test_reporting_login, (a,)), (test_application_login, (a,)), (test_tier_follows_expiry, ()),
                     (test_holder_separation_of_duties, ()), (test_provisioning_context, ()), (test_worker_routines, ())):
        try:
            fn(*args)
        except Exception as exc:                      # noqa: BLE001
            ok(False, f"{fn.__name__} raised: {exc}")
    print(f"\n{len(PASSES)} passed, {len(FAILURES)} failed")
    sys.exit(1 if FAILURES else 0)
