-- =====================================================================
-- Test assertion helpers
-- =====================================================================
-- Loaded into the test database only, by db/tools/run_tests.py. Not a
-- migration: these must never exist in a production database.
--
-- An assertion that fails raises, which aborts the test file's transaction and
-- is what the runner reports as a failure. There is no "expected/actual"
-- bookkeeping table, because a test that cannot write its own result is a test
-- that cannot lie about it.
SET ROLE lms_owner;
CREATE SCHEMA IF NOT EXISTS test;

CREATE OR REPLACE FUNCTION test.ok(p_cond boolean, p_label text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_label USING ERRCODE = 'assert_failure';
  END IF;
  RAISE NOTICE 'ok   %', p_label;
END $$;

CREATE OR REPLACE FUNCTION test.eq(p_a anyelement, p_b anyelement, p_label text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_a IS DISTINCT FROM p_b THEN
    RAISE EXCEPTION 'FAIL: % — expected %, got %', p_label, p_b, p_a
      USING ERRCODE = 'assert_failure';
  END IF;
  RAISE NOTICE 'ok   % (%)', p_label, p_b;
END $$;

-- Assert that a statement fails, optionally with a particular SQLSTATE.
--
-- The statement runs inside a BEGIN/EXCEPTION block, which PostgreSQL
-- implements as a subtransaction, so the failure is rolled back to this point
-- and the test file can carry on. p_errcode NULL accepts any error; naming the
-- code is better, because it checks that the right rule refused rather than
-- that something happened to break.
CREATE OR REPLACE FUNCTION test.throws(p_sql text, p_errcode text, p_label text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
    IF p_errcode IS NOT NULL AND v_state <> p_errcode THEN
      RAISE EXCEPTION 'FAIL: % — expected SQLSTATE %, got % (%)',
        p_label, p_errcode, v_state, v_msg USING ERRCODE = 'assert_failure';
    END IF;
    RAISE NOTICE 'ok   % (% %)', p_label, v_state, left(v_msg, 70);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: % — the statement was expected to fail but succeeded', p_label
    USING ERRCODE = 'assert_failure';
END $$;

-- Same, but asserts on the message text as well, for rules whose SQLSTATE is a
-- generic raise_exception and whose message is the thing worth pinning.
CREATE OR REPLACE FUNCTION test.throws_like(p_sql text, p_pattern text, p_label text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg NOT ILIKE p_pattern THEN
      RAISE EXCEPTION 'FAIL: % — message "%" does not match "%"', p_label, v_msg, p_pattern
        USING ERRCODE = 'assert_failure';
    END IF;
    RAISE NOTICE 'ok   % (%)', p_label, left(v_msg, 70);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: % — the statement was expected to fail but succeeded', p_label
    USING ERRCODE = 'assert_failure';
END $$;

GRANT USAGE ON SCHEMA test TO lms_readwrite, lms_readonly;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO lms_readwrite, lms_readonly;

-- Named ids for the seeded demo records, so a test does not repeat a lookup.
CREATE OR REPLACE VIEW test.fixtures AS
SELECT
  (SELECT id FROM lms.app_user WHERE username='admin')    AS u_admin,
  (SELECT id FROM lms.app_user WHERE username='lofield')  AS u_lofield,
  (SELECT id FROM lms.app_user WHERE username='nego')     AS u_nego,
  (SELECT id FROM lms.app_user WHERE username='legal')    AS u_legal,
  (SELECT id FROM lms.app_user WHERE username='sradmin')  AS u_sradmin,
  (SELECT id FROM lms.app_user WHERE username='dmfield')  AS u_dmfield,
  (SELECT id FROM lms.app_user WHERE username='mland')    AS u_mland,
  (SELECT id FROM lms.app_user WHERE username='finance')  AS u_finance,
  (SELECT id FROM lms.app_user WHERE username='viewer')   AS u_viewer,
  (SELECT id FROM lms.app_user WHERE username='audit')    AS u_audit,
  (SELECT id FROM lms.app_user WHERE username='loquetta') AS u_lobal,
  (SELECT id FROM lms.app_user WHERE username='negoqta')  AS u_negoqta,
  (SELECT id FROM lms.compensation_case WHERE code='CC-2026-0001') AS case_approved,
  (SELECT id FROM lms.compensation_case WHERE code='CC-2026-0002') AS case_draft,
  (SELECT id FROM lms.compensation_case WHERE code='CC-2026-0003') AS case_bal,
  (SELECT id FROM lms.project WHERE code='DHRK-001') AS proj_dhrk1,
  (SELECT id FROM lms.project WHERE code='SUI-004')  AS proj_sui,
  (SELECT id FROM lms.survey WHERE survey_no='112' AND province_code='SND') AS survey_112,
  (SELECT id FROM lms.survey WHERE survey_no='113' AND province_code='SND') AS survey_113,
  (SELECT id FROM lms.survey WHERE survey_no='1187' AND province_code='BAL') AS survey_1187,
  (SELECT id FROM lms.survey WHERE survey_no='207' AND province_code='SND') AS survey_207,
  (SELECT id FROM lms.landowner WHERE cnic='45102-1100012-3') AS lo_mukhtiar,
  (SELECT id FROM lms.landowner WHERE cnic='45102-1100013-6') AS lo_zubaida,
  (SELECT id FROM lms.landowner WHERE cnic='52101-1200021-4') AS lo_shahbaz,
  (SELECT id FROM lms.landowner WHERE cnic='45102-1100014-9') AS lo_rasool,
  (SELECT id FROM lms.payment_request WHERE remarks LIKE 'Year 1 lease rent, 60%%') AS pay_released,
  (SELECT id FROM lms.payment_request WHERE remarks LIKE 'Year 1 lease rent, 40%%') AS pay_verified,
  (SELECT id FROM lms.mutation LIMIT 1) AS mutation1,
  (SELECT id FROM lms.legal_case LIMIT 1) AS legal1,
  (SELECT id FROM lms.lease WHERE province_code='SND' LIMIT 1) AS lease_snd;
GRANT SELECT ON test.fixtures TO lms_readwrite, lms_readonly;

-- Set the actor by username.
--
-- SECURITY DEFINER, and only in the test database: resolving a username to an
-- id needs to read lms.app_user, which row-level security hides from a session
-- that has no actor set yet. The real application never needs this — it knows
-- its user's id from the authenticated session — so this helper exists for
-- tests and nowhere else.
CREATE OR REPLACE FUNCTION test.become(p_username text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM lms.app_user WHERE username = p_username::ext.citext;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no test user named %', p_username;
  END IF;
  PERFORM api.set_actor(v_id);
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION test.become(text) TO lms_readwrite, lms_readonly;

-- Clear the actor, for the tests that check what happens without one.
CREATE OR REPLACE FUNCTION test.unbecome() RETURNS void
  LANGUAGE sql SET search_path = pg_catalog, pg_temp
AS $$ SELECT set_config('lms.actor_id', '', true) $$;
GRANT EXECUTE ON FUNCTION test.unbecome() TO lms_readwrite, lms_readonly;

-- Whether the database treats the current actor as the system account. The
-- application cannot call iam.is_system_actor() itself; this wrapper runs as
-- the owner but still sees the caller's session (session_user), which is what
-- the rule depends on.
CREATE OR REPLACE FUNCTION test.is_system_actor() RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT iam.is_system_actor() $$;
GRANT EXECUTE ON FUNCTION test.is_system_actor() TO lms_readwrite, lms_readonly;
