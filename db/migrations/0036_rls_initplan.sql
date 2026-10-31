-- =====================================================================
-- 0036  Row-level security evaluated once per query, not once per row
-- =====================================================================
-- Every province-scope policy reads
--     actor_role() = 'Admin' OR province_code = ANY (actor_provinces())
-- and others call actor_groups(), util.actor_id() or iam.has_permission('r','a').
-- These functions are STABLE and SECURITY DEFINER with a pinned search_path,
-- so PostgreSQL cannot inline them and calls them for every row it filters.
-- Measured on the volume fixture (db/tools/perf_load.sql) as lms_app: the
-- filter alone cost ~23 µs per row — 2.9 s to scan 120,000 payment requests,
-- 1.4 s for 60,000 surveys.
--
-- Wrapping each call in a scalar sub-select makes it an InitPlan, evaluated
-- once per statement. The result is identical (the functions depend only on
-- the session's actor, which cannot change inside a statement), so this
-- changes cost, not meaning: the same rows are visible and writable.
-- Policies are rewritten in place, keeping their name, command, roles and
-- permissive/restrictive kind.
SET ROLE lms_owner;

DO $$
DECLARE
  p record;
  q text; c text; nq text; nc text;
  n int := 0;
BEGIN
  -- Fully qualified names in pg_get_expr output, so the rewrite is exact.
  PERFORM set_config('search_path', 'pg_catalog', true);
  FOR p IN
    SELECT pol.polname, pol.polrelid::regclass AS tbl,
           pg_get_expr(pol.polqual, pol.polrelid) AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS chk
      FROM pg_policy pol
      JOIN pg_class cl ON cl.oid = pol.polrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE ns.nspname IN ('lms', 'iam', 'audit')
  LOOP
    q := p.qual; c := p.chk; nq := q; nc := c;
    IF q IS NOT NULL THEN
      nq := regexp_replace(nq, '(lms\.actor_role|util\.actor_id)\(\)', '(SELECT \1())', 'g');
      -- Array-valued: cast so "= ANY (...)" stays the array form, not the sub-query form.
      nq := regexp_replace(nq, 'lms\.actor_provinces\(\)', '(SELECT lms.actor_provinces())::bpchar[]', 'g');
      nq := regexp_replace(nq, 'lms\.actor_groups\(\)', '(SELECT lms.actor_groups())::text[]', 'g');
      nq := regexp_replace(nq, 'iam\.has_permission\((''[^'']*''::text), (''[^'']*''::text)\)', '(SELECT iam.has_permission(\1, \2))', 'g');
    END IF;
    IF c IS NOT NULL THEN
      nc := regexp_replace(nc, '(lms\.actor_role|util\.actor_id)\(\)', '(SELECT \1())', 'g');
      -- Array-valued: cast so "= ANY (...)" stays the array form, not the sub-query form.
      nc := regexp_replace(nc, 'lms\.actor_provinces\(\)', '(SELECT lms.actor_provinces())::bpchar[]', 'g');
      nc := regexp_replace(nc, 'lms\.actor_groups\(\)', '(SELECT lms.actor_groups())::text[]', 'g');
      nc := regexp_replace(nc, 'iam\.has_permission\((''[^'']*''::text), (''[^'']*''::text)\)', '(SELECT iam.has_permission(\1, \2))', 'g');
    END IF;
    IF nq IS DISTINCT FROM q OR nc IS DISTINCT FROM c THEN
      EXECUTE format('ALTER POLICY %I ON %s%s%s', p.polname, p.tbl,
        CASE WHEN nq IS NOT NULL THEN format(' USING (%s)', nq) ELSE '' END,
        CASE WHEN nc IS NOT NULL THEN format(' WITH CHECK (%s)', nc) ELSE '' END);
      n := n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0036: % policies rewritten', n;
  -- Nothing may still call these per row.
  IF EXISTS (
    SELECT 1 FROM pg_policy pol
     WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
           ~ '(?<!SELECT )(lms\.actor_role|lms\.actor_provinces|lms\.actor_groups|util\.actor_id)\(\)'
  ) THEN
    RAISE EXCEPTION '0036: a policy still calls an actor function per row';
  END IF;
END $$;

RESET ROLE;
