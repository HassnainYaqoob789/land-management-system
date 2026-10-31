-- =====================================================================
-- 0053  Parcel-commitment triggers run as their owner
-- =====================================================================
-- 0043 added three deferred constraint triggers (case lease lines, case
-- term/stage, parcel area) that call lms.check_survey_commitment(), a
-- SECURITY DEFINER routine whose EXECUTE it revoked from PUBLIC and granted
-- to nobody. The trigger functions themselves were not definers, so at COMMIT
-- they called it as the application role and failed with "permission denied
-- for function check_survey_commitment". Every compensation case saved
-- through the application with a lease line (and every case advanced to an
-- approval stage, or parcel area reduced) was refused at commit; the API
-- answered 403. Owner sessions (seed, DB tests) never noticed.
-- Found by tests/regression/workflows.test.ts on 2026-10-30.
--
-- The trigger functions now run as their owner, which may call the check.
-- The check itself stays closed to the application: it locks a parcel row
-- (FOR UPDATE), so it is not something a client should be able to call.

SET ROLE lms_owner;

ALTER FUNCTION lms.tg_case_line_commitment()   SECURITY DEFINER;
ALTER FUNCTION lms.tg_case_term_commitment()   SECURITY DEFINER;
ALTER FUNCTION lms.tg_survey_area_commitment() SECURITY DEFINER;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_proc
   WHERE oid IN ('lms.tg_case_line_commitment()'::regprocedure, 'lms.tg_case_term_commitment()'::regprocedure,
                 'lms.tg_survey_area_commitment()'::regprocedure)
     AND prosecdef AND proconfig IS NOT NULL;   -- definer, with its pinned search_path
  IF n <> 3 THEN RAISE EXCEPTION '0053: expected 3 definer trigger functions, found %', n; END IF;
END $$;

RESET ROLE;
