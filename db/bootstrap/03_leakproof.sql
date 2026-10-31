-- =====================================================================
-- Optional cluster step: mark citext equality LEAKPROOF
-- =====================================================================
-- Run ONCE per cluster, as a superuser, after the extensions exist:
--
--   psql -d lms_dev -f db/bootstrap/03_leakproof.sql
--
-- This is a deliberate, reviewable decision for a database administrator to
-- make, which is why it is a bootstrap step and not a migration: only a
-- superuser may mark a function leakproof, and the judgement belongs to
-- whoever owns the cluster.
--
-- THE PROBLEM IT SOLVES
--
-- Record codes (AREA-000001, CC-2026-0001, VCH-2026-00001) are the domain
-- lms.record_code, which is built on citext so that a code typed in the wrong
-- case still matches. Looking a record up by its code is one of the commonest
-- things anyone does in this system.
--
-- Under row-level security, PostgreSQL will not evaluate a user's own WHERE
-- clause before the security policy unless the operator in it is marked
-- LEAKPROOF — otherwise an error message from the user's qual could reveal a
-- value from a row the policy would have hidden. citext's equality operator is
-- NOT marked leakproof (text's and uuid's are), so the planner cannot use the
-- unique index on a code column, and every code lookup becomes a sequential
-- scan of the whole table.
--
-- Measured on the volume fixture (60,013 parcels, 20 MB table), as the
-- application role with policies in force:
--
--   SELECT id FROM lms.survey WHERE code = 'PF-S0000042';
--     without this step:  Seq Scan, 60,012 rows discarded, ~207 ms
--     with this step:     Index Scan using survey_code_key,         ~0.2 ms
--
-- The cost grows linearly with the table, so the gap widens over the system's
-- life.
--
-- THE JUDGEMENT BEING MADE
--
-- Marking a function leakproof asserts that it cannot leak information about
-- its arguments other than through its return value — in particular that it
-- throws no error whose message or whose occurrence depends on the data.
--
-- citext_eq lowercases both arguments and compares the results. It allocates,
-- folds case and runs a byte comparison. It has no data-dependent error path:
-- it cannot divide by zero, cannot overflow, cannot fail to parse. On that
-- basis the assertion holds, and this is the same reasoning by which the core
-- texteq is already leakproof.
--
-- WHAT COULD GO WRONG
--
-- An out-of-memory condition on a pathological input is in principle
-- observable, and a future change to the citext extension could introduce an
-- error path this review did not anticipate. The exposure if that happened
-- would be narrow: an attacker who could already run arbitrary queries might
-- learn whether a code they guessed exists outside their province. They would
-- not learn its contents, and every such query is attributed and audited.
--
-- THE ALTERNATIVE, IF THIS IS DECLINED
--
-- Rebuild lms.record_code on plain text and get case-insensitive matching from
-- a functional index on upper(code), comparing with upper($1). text equality
-- is already leakproof, so the index becomes usable. That is the more
-- conservative option and it is a schema change affecting about thirty
-- columns and several routine signatures, so it is not made speculatively.
--
-- If this step is not run, nothing breaks: code lookups are correct and slow.
-- docs/QUERY_PLAN_EVIDENCE.md reports the measurement both ways, and
-- docs/SECURITY_FINDINGS.md records the decision as DB-12.
-- =====================================================================
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'this step must be run by a superuser'
      USING HINT = 'only a superuser may mark a function LEAKPROOF';
  END IF;
END $$;

-- Both the operator function and the pattern-matching companions a code
-- lookup can use. If the citext extension is not installed in schema ext,
-- nothing is changed and the script says so.
DO $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n2 ON n2.oid = p.pronamespace
    WHERE n2.nspname = 'ext'
      AND p.proname IN ('citext_eq', 'citext_ne', 'citext_lt', 'citext_le',
                        'citext_gt', 'citext_ge', 'citext_cmp', 'citext_hash')
      AND NOT p.proleakproof
  LOOP
    EXECUTE format('ALTER FUNCTION %s LEAKPROOF', r.sig);
    RAISE NOTICE 'marked LEAKPROOF: %', r.sig;
    n := n + 1;
  END LOOP;
  IF n = 0 THEN
    RAISE NOTICE 'nothing to change: citext is not installed in schema ext, '
                 'or its operators are already leakproof';
  ELSE
    RAISE NOTICE '% function(s) marked. Code lookups can now use their indexes '
                 'under row-level security.', n;
  END IF;
END $$;
