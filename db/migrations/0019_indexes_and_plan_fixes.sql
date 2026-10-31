-- =====================================================================
-- 0019  Indexes, and the view rewrites the measurements asked for
-- =====================================================================
-- Nothing in this file was added on the assumption that it would help. The
-- plans in docs/QUERY_PLAN_EVIDENCE.md were measured first, at the volumes in
-- db/tools/perf_load.sql (60k parcels, 50k landowners, 30k cases, 120k
-- vouchers, 296k audit events, 368 MB), with row-level security in force, and
-- the entries below are what those plans called for. The same document records
-- what changed afterwards, including the queries that did not improve.
--
-- Two things came out of the baseline:
--
--   1. Several screens were scanning a large table to find a handful of rows.
--      Those are index problems, and the indexes are below.
--
--   2. Three views called api.case_liability() once per row through a LATERAL
--      join — 30,000 function calls, each running two aggregates. No index
--      fixes that; the shape of the query is wrong. Those views are rewritten
--      set-based further down, which is where most of the improvement comes
--      from. An index would have papered over it.
--
-- What is deliberately NOT indexed:
--
--   * province_code on its own. There are four provinces, so the row-level
--     security predicate selects roughly a quarter of any table and a
--     sequential scan is the right plan. Province appears here only as the
--     leading column of a composite index whose later columns are selective.
--   * The small reference tables (province, workflow, workflow_stage, the
--     category lookups). A sequential scan of 16 rows beats an index lookup,
--     and the planner knows it.
--   * Columns that already have an index as a side effect of a constraint.
--     Every primary key and unique constraint has one; adding another on the
--     same leading column would be pure write overhead. The foreign keys
--     indexed below are the ones a measured query joins on, not all of them.
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Landowner search
--
-- q01 took 11.6 seconds and read 3.9 million buffers: an ILIKE on
-- lms.landowner cannot use a B-tree at all, because the pattern is not
-- anchored, so the whole table was scanned and the per-row subqueries ran for
-- every candidate. A trigram GIN index makes the pattern itself indexable.
--
-- GIN rather than GiST: this is a read-mostly register where exact-match
-- recall matters more than index size, and GIN is faster to search. The cost
-- is a slower write and a bigger index, which a landowner register — written
-- once, searched constantly — can afford.
-- ---------------------------------------------------------------------
CREATE INDEX landowner_name_trgm_idx ON lms.landowner
  USING gin (full_name ext.gin_trgm_ops);
COMMENT ON INDEX lms.landowner_name_trgm_idx IS
  'Unanchored ILIKE on the landowner name: the search every field officer '
  'starts from. Measured 11.6s -> see docs/QUERY_PLAN_EVIDENCE.md.';

CREATE INDEX landowner_father_trgm_idx ON lms.landowner
  USING gin (father_name ext.gin_trgm_ops);
COMMENT ON INDEX lms.landowner_father_trgm_idx IS
  'The same search by father''s name, which is how a landowner is disambiguated '
  'when several share a name.';

-- ---------------------------------------------------------------------
-- Payments
--
-- "What has this landowner been paid" and "what is outstanding on this case"
-- are the two commonest financial questions, and both were sequential scans
-- of a 65 MB table.
-- ---------------------------------------------------------------------
CREATE INDEX payment_request_landowner_period_idx ON lms.payment_request
  (landowner_id, period_from DESC) WHERE landowner_id IS NOT NULL;
COMMENT ON INDEX lms.payment_request_landowner_period_idx IS
  'Payment history for a landowner, newest first. Partial because an external '
  'payee (a Board of Revenue) has no landowner_id and those rows would only '
  'make the index bigger.';

CREATE INDEX payment_request_case_idx ON lms.payment_request (case_id)
  WHERE case_id IS NOT NULL;
CREATE INDEX payment_request_project_period_idx ON lms.payment_request
  (project_id, period_from);
COMMENT ON INDEX lms.payment_request_project_period_idx IS
  'The budget position: payments for a project within a financial year. '
  'Column order matters — project first, because every such query fixes the '
  'project and ranges over the period, never the other way round.';

-- Committed-but-unpaid liabilities. Partial on the two live stages, which are
-- about a fifth of the table and the only ones the budget check counts.
CREATE INDEX payment_request_pending_idx ON lms.payment_request
  (project_id, period_from) WHERE stage_code IN ('Requested','Verified');
COMMENT ON INDEX lms.payment_request_pending_idx IS
  'Pending liabilities for the budget check. Partial, so it stays small as the '
  'released history grows: the index does not grow with the table, only with '
  'the work in progress.';

CREATE INDEX payment_request_dbpfc_idx ON lms.payment_request (dbpfc_id)
  WHERE dbpfc_id IS NOT NULL;
CREATE INDEX payment_request_lease_idx ON lms.payment_request (lease_id)
  WHERE lease_id IS NOT NULL;

CREATE INDEX payment_allocation_case_idx ON lms.payment_allocation (case_id);
COMMENT ON INDEX lms.payment_allocation_case_idx IS
  'The case side of an allocation. The table''s unique constraint indexes '
  '(payment_id, case_id, landowner_id), which serves the payment side only; '
  'a B-tree cannot be read from its second column.';

CREATE INDEX payment_release_cheque_date_idx ON lms.payment_release
  (province_code, cheque_date DESC);
COMMENT ON INDEX lms.payment_release_cheque_date_idx IS
  'The payment register, which is always "this province, this period".';

CREATE INDEX payment_receipt_release_idx ON lms.payment_receipt (release_id);

-- ---------------------------------------------------------------------
-- Compensation cases
-- ---------------------------------------------------------------------
CREATE INDEX case_province_stage_date_idx ON lms.compensation_case
  (province_code, stage_code, case_date DESC);
COMMENT ON INDEX lms.case_province_stage_date_idx IS
  'The case list: a province, a stage, newest first. Province leads because '
  'row-level security always restricts it, so it is in every query whether the '
  'application asked for it or not; stage is the selective part.';

CREATE INDEX case_project_stage_idx ON lms.compensation_case (project_id, stage_code);

-- The liability register reads approved cases only — a little over half the
-- table, but the index also carries approved_at for the sort, which turns the
-- query into an index scan with no separate sort step.
CREATE INDEX case_approved_idx ON lms.compensation_case
  (province_code, approved_at DESC) WHERE stage_code = 'HO Approved';

CREATE INDEX case_lease_line_survey_idx ON lms.case_lease_line (survey_id);
COMMENT ON INDEX lms.case_lease_line_survey_idx IS
  '"How much of this parcel is committed" — the parcel side of the line. The '
  'primary key leads with case_id and cannot answer it.';

CREATE INDEX case_owner_landowner_idx ON lms.case_owner (landowner_id);
CREATE INDEX case_crop_line_survey_idx ON lms.case_crop_line (survey_id) WHERE survey_id IS NOT NULL;
CREATE INDEX case_tree_line_survey_idx ON lms.case_tree_line (survey_id) WHERE survey_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Land
-- ---------------------------------------------------------------------
CREATE INDEX survey_admin_unit_idx ON lms.survey (admin_unit_id);
CREATE INDEX survey_province_status_idx ON lms.survey (province_code, status_code);
CREATE INDEX survey_ownership_landowner_idx ON lms.survey_ownership_share (landowner_id);
COMMENT ON INDEX lms.survey_ownership_landowner_idx IS
  '"What does this person own" — the owner side of the holding. The unique '
  'constraint indexes (survey_id, landowner_id), which answers the parcel side.';

CREATE INDEX admin_unit_parent_idx ON lms.admin_unit (parent_id) WHERE parent_id IS NOT NULL;
COMMENT ON INDEX lms.admin_unit_parent_idx IS
  'The recursive walk up the administrative tree that every location path '
  'does. Partial: the four-odd roots have no parent and need no entry.';

CREATE INDEX project_survey_survey_idx ON lms.project_survey (survey_id);
CREATE INDEX project_province_status_idx ON lms.project (province_code, status);
CREATE INDEX project_district_idx ON lms.project (district_id);

-- ---------------------------------------------------------------------
-- Leases and ROW
--
-- The expiry alert is the clearest case for a partial index in the schema: it
-- asks for approved, unterminated leases ending within 180 days, which is a
-- small and shrinking slice of a growing table.
-- ---------------------------------------------------------------------
CREATE INDEX lease_expiry_idx ON lms.lease (end_date)
  WHERE stage_code = 'Approved' AND terminated_on IS NULL;
COMMENT ON INDEX lms.lease_expiry_idx IS
  'Lease expiry alerts. Partial on approved and unterminated: a draft or a '
  'surrendered lease has no expiry to alert on, and excluding them keeps the '
  'index proportional to the live register rather than to its history.';

CREATE INDEX lease_project_idx ON lms.lease (project_id);
CREATE INDEX lease_case_idx ON lms.lease (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX lease_lessor_landowner_idx ON lms.lease_lessor (landowner_id);
CREATE INDEX lease_survey_survey_idx ON lms.lease_survey (survey_id);
CREATE INDEX lease_renewal_lease_idx ON lms.lease_renewal (lease_id);

CREATE INDEX row_corridor_project_idx ON lms.row_corridor (project_id);
CREATE INDEX row_corridor_renewal_idx ON lms.row_corridor (agreement_date)
  WHERE stage_code = 'Approved';
CREATE INDEX row_survey_survey_idx ON lms.row_survey (survey_id);
CREATE INDEX row_landowner_landowner_idx ON lms.row_landowner (landowner_id);

-- ---------------------------------------------------------------------
-- Cases of work in progress. Every one of these is partial on "not finished",
-- because that is what the operational screens ask for and it is the part that
-- does not grow.
-- ---------------------------------------------------------------------
CREATE INDEX grievance_open_idx ON lms.grievance (province_code, due_date)
  WHERE resolved_on IS NULL;
CREATE INDEX grievance_landowner_idx ON lms.grievance (landowner_id) WHERE landowner_id IS NOT NULL;
CREATE INDEX grievance_project_idx ON lms.grievance (project_id) WHERE project_id IS NOT NULL;

CREATE INDEX encroachment_open_idx ON lms.encroachment (province_code, risk)
  WHERE stage_code <> 'Resolved';
CREATE INDEX encroachment_row_idx ON lms.encroachment (row_id) WHERE row_id IS NOT NULL;
CREATE INDEX encroachment_survey_idx ON lms.encroachment (survey_id) WHERE survey_id IS NOT NULL;

CREATE INDEX legal_case_stay_idx ON lms.legal_case (province_code) WHERE stay_order;
COMMENT ON INDEX lms.legal_case_stay_idx IS
  'Cases under a stay order: a handful of rows out of the whole register, and '
  'the payment path checks for them on every release.';
CREATE INDEX legal_case_hearing_idx ON lms.legal_case (next_hearing)
  WHERE status IN ('Pending','Under Hearing','Reserved for Judgment','In Appeal');
CREATE INDEX legal_hearing_case_idx ON lms.legal_hearing (legal_case_id);

CREATE INDEX mutation_transferor_idx ON lms.mutation (transferor_id);
CREATE INDEX dbpfc_project_idx ON lms.dbpfc_estimate (project_id);
CREATE INDEX budget_project_year_already_unique_note_idx ON lms.budget (fiscal_year);
COMMENT ON INDEX lms.budget_project_year_already_unique_note_idx IS
  'Year on its own, for the "all projects, this year" report. '
  '(project_id, fiscal_year) is already unique and serves the other direction.';

CREATE INDEX workflow_assignment_group_idx ON lms.workflow_assignment
  (assigned_group, stage_code) WHERE closed_at IS NULL;
COMMENT ON INDEX lms.workflow_assignment_group_idx IS
  'The approval queue: what is waiting on my position. Partial on open, which '
  'is the whole question.';
CREATE INDEX workflow_assignment_user_idx ON lms.workflow_assignment (assigned_user)
  WHERE closed_at IS NULL AND assigned_user IS NOT NULL;

CREATE INDEX document_entity_idx ON lms.document (entity, record_id, version DESC);
CREATE INDEX document_access_doc_idx ON lms.document_access_log (document_id, accessed_at DESC);

-- JSONB containment on the audit diff: "which changes touched the lease rate".
-- GIN with jsonb_path_ops rather than the default operator class, because the
-- only operator used is containment (@>) and path_ops is markedly smaller and
-- faster for it. The cost is that it cannot answer key-existence (?) queries,
-- which nothing here asks.
CREATE INDEX audit_event_new_data_idx ON audit.audit_event
  USING gin (new_data jsonb_path_ops);
COMMENT ON INDEX audit.audit_event_new_data_idx IS
  'Containment searches over the audit diff. jsonb_path_ops, not the default: '
  'smaller and faster for @>, at the price of not supporting ? — which no '
  'query in this system uses.';

CREATE INDEX audit_event_entity_action_idx ON audit.audit_event (entity, action, occurred_at DESC);
CREATE INDEX record_version_lookup_idx ON audit.record_version (entity, record_id, version DESC);

-- ---------------------------------------------------------------------
-- The query-shape fixes.
--
-- Three problems in the baseline were not index problems, and an index would
-- only have hidden them:
--
--   1. Three views called api.case_liability() once per row through a LATERAL
--      join — 30,000 function calls, two aggregates each.
--   2. api.v_admin_unit_path recursed over the whole administrative tree on
--      every query that wanted one parcel's location, and the recursion then
--      blocked the planner from using the parcel's own unique index.
--   3. api.v_province_summary runs sixteen aggregate subqueries per province,
--      four provinces at a time, over every large table in the schema.
--
-- (1) is fixed by aggregating per row with an index instead of per row with a
-- function. (2) and (3) are fixed with materialized views, which is the only
-- place in this schema they are used, and the measurements in
-- docs/QUERY_PLAN_EVIDENCE.md are the justification.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Materialized: the administrative location path.
--
-- Why materialized and not just indexed: the cost is the recursion itself, not
-- a missing index. lms.admin_unit is master data — 1,464 rows here, a few
-- thousand at full national coverage — and it changes when a district is
-- reorganised, which is a matter of months, not minutes. Recomputing a path
-- on every parcel lookup is paying continuously for something that changes
-- almost never.
--
-- Freshness: the contents are correct as of the last refresh. Because the
-- source is master data, a stale path means a newly added Deh has no path
-- until the refresh runs, which the application detects through
-- lms.derived_refresh (below) and which a nightly job clears. No financial or
-- workflow decision reads this view, so staleness here cannot affect a
-- payment or an approval.
--
-- Refresh: api.refresh_derived(), outside a transaction, so CONCURRENTLY can
-- be used and readers are never blocked. CONCURRENTLY requires a unique index,
-- which is the one below.
-- ---------------------------------------------------------------------
CREATE MATERIALIZED VIEW lms.admin_unit_path AS
WITH RECURSIVE t AS (
  SELECT u.id, u.province_code, u.level, u.parent_id, u.name, u.code,
         u.name::text AS path, u.id AS district_id
  FROM lms.admin_unit u WHERE u.parent_id IS NULL
  UNION ALL
  SELECT u.id, u.province_code, u.level, u.parent_id, u.name, u.code,
         t.path || ' → ' || u.name, t.district_id
  FROM lms.admin_unit u JOIN t ON t.id = u.parent_id
)
SELECT id AS admin_unit_id, code, province_code, level, parent_id, name, path, district_id
FROM t;

CREATE UNIQUE INDEX admin_unit_path_pk ON lms.admin_unit_path (admin_unit_id);
CREATE INDEX admin_unit_path_province_idx ON lms.admin_unit_path (province_code, level);
COMMENT ON MATERIALIZED VIEW lms.admin_unit_path IS
  'Precomputed "District → Taluka → Deh" paths. Materialized because the '
  'recursion cost is paid per query while the source changes once in months. '
  'Refreshed by api.refresh_derived(); staleness affects display only.';

-- A materialized view has no row-level security of its own: its contents are
-- computed once, by the owner, and a query against it is not filtered by the
-- caller's policies. So the materialized view is NOT granted to any
-- application role, and the view that replaces the recursive one runs with
-- owner rights and restates the province predicate in its own body — the same
-- arrangement as the masked views in migration 0017, and recorded under the
-- same finding (DB-05).
--
-- The alternative — granting SELECT on the materialized view and keeping the
-- view security_invoker — was rejected: it would have made every province's
-- administrative unit names visible to every account. The names are not
-- sensitive, but widening a scope as a side effect of a performance change is
-- how a boundary quietly stops holding.
-- Replaced in place rather than dropped: api.v_survey_ownership reads it, so a
-- DROP would need CASCADE and would take that view with it. The column list is
-- unchanged, so CREATE OR REPLACE can do the job — including turning
-- security_invoker off, which the WITH clause here does.
CREATE OR REPLACE VIEW api.v_admin_unit_path WITH (security_invoker = false) AS
SELECT admin_unit_id, code, province_code, level, parent_id, name, path, district_id
FROM lms.admin_unit_path
WHERE lms.actor_role() = 'Admin'
   OR province_code = ANY (lms.actor_provinces());
COMMENT ON VIEW api.v_admin_unit_path IS
  'Owner-rights view (NOT security_invoker) over lms.admin_unit_path, with the '
  'province predicate restated in the body because a materialized view cannot '
  'carry row-level security. See DB-05 in docs/SECURITY_FINDINGS.md.';
GRANT SELECT ON api.v_admin_unit_path TO lms_readwrite, lms_readonly;

-- Which derived objects are out of date, and since when. A trigger cannot
-- refresh a materialized view (REFRESH cannot run inside the transaction that
-- fired it), so it records that one is needed and a maintenance job acts on it.
CREATE TABLE lms.derived_refresh (
  object_name   text PRIMARY KEY,
  is_stale      boolean NOT NULL DEFAULT false,
  marked_at     timestamptz,
  refreshed_at  timestamptz,
  refresh_ms    integer,
  max_staleness interval NOT NULL,
  note          text
);
COMMENT ON TABLE lms.derived_refresh IS
  'Refresh state for the materialized views. max_staleness is the operational '
  'expectation, so a monitoring check can alarm on a refresh that stopped '
  'running rather than on a schedule nobody is watching.';

INSERT INTO lms.derived_refresh (object_name, max_staleness, note) VALUES
  ('lms.admin_unit_path',   interval '1 day',
   'Administrative hierarchy paths. Source is master data; display only.'),
  ('lms.province_summary',  interval '15 minutes',
   'Executive dashboard aggregates. Read as "as at the last refresh"; the '
   'operational screens read the live tables.');

CREATE FUNCTION lms.tg_mark_derived_stale() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE lms.derived_refresh
     SET is_stale = true, marked_at = coalesce(marked_at, clock_timestamp())
   WHERE object_name = TG_ARGV[0] AND NOT is_stale;
  RETURN NULL;
END $$;
COMMENT ON FUNCTION lms.tg_mark_derived_stale() IS
  'Records that a materialized view needs refreshing. It cannot refresh one '
  'itself: REFRESH MATERIALIZED VIEW cannot run inside the transaction that '
  'modified the source, and CONCURRENTLY cannot run in a transaction at all.';

CREATE TRIGGER admin_unit_marks_path_stale
  AFTER INSERT OR UPDATE OR DELETE ON lms.admin_unit
  FOR EACH STATEMENT EXECUTE FUNCTION lms.tg_mark_derived_stale('lms.admin_unit_path');

-- ---------------------------------------------------------------------
-- Materialized: the executive dashboard.
--
-- Measured at roughly a second for four rows, because it asks sixteen
-- questions of every large table in the schema. It is also the screen most
-- people open first and the one that tolerates staleness best: nobody makes a
-- decision on a province-level count that cannot be fifteen minutes old.
--
-- Access control: a materialized view cannot carry row-level security, so this
-- one is NOT granted to any application role. api.v_province_summary — the
-- live, security_invoker view — remains the only thing the application reads,
-- and api.v_province_summary_cached below is the wrapper that reads the
-- materialized copy with the province predicate restated in its body. That
-- predicate is the same function call the policies use; the risk that the two
-- drift apart is recorded as DB-05 in docs/SECURITY_FINDINGS.md and is held
-- down by db/tests/test_05_views_rls.sql.
-- ---------------------------------------------------------------------
CREATE MATERIALIZED VIEW lms.province_summary AS
SELECT pv.code AS province_code, pv.name AS province_name, pv.display_order,
       (SELECT count(*) FROM lms.project   x WHERE x.province_code = pv.code)                      AS projects,
       (SELECT count(*) FROM lms.project   x WHERE x.province_code = pv.code AND x.status = 'Active') AS active_projects,
       (SELECT count(*) FROM lms.survey    x WHERE x.province_code = pv.code)                      AS parcels,
       (SELECT coalesce(sum(x.total_area),0) FROM lms.survey x WHERE x.province_code = pv.code)    AS total_area_acres,
       (SELECT count(*) FROM lms.landowner x WHERE x.province_code = pv.code)                      AS landowners,
       (SELECT count(*) FROM lms.compensation_case x
         WHERE x.province_code = pv.code AND x.stage_code NOT IN ('Cancelled','Stopped'))          AS live_cases,
       (SELECT count(*) FROM lms.compensation_case x
         WHERE x.province_code = pv.code AND x.stage_code = 'HO Approved')                         AS approved_cases,
       (SELECT coalesce(sum(x.total_amount),0) FROM lms.compensation_case x
         WHERE x.province_code = pv.code AND x.stage_code = 'HO Approved')                         AS approved_compensation,
       (SELECT coalesce(sum(r.released_amount),0) FROM lms.payment_release r
         WHERE r.province_code = pv.code)                                                          AS released_amount,
       (SELECT count(*) FROM lms.lease x
         WHERE x.province_code = pv.code AND x.stage_code = 'Approved'
           AND x.terminated_on IS NULL AND x.end_date >= current_date)                             AS active_leases,
       (SELECT count(*) FROM lms.lease x
         WHERE x.province_code = pv.code AND x.stage_code = 'Approved'
           AND x.terminated_on IS NULL AND x.end_date BETWEEN current_date AND current_date + 90)  AS leases_expiring_90d,
       (SELECT count(*) FROM lms.grievance x
         WHERE x.province_code = pv.code AND x.stage_code NOT IN ('Resolved','Closed'))            AS open_grievances,
       (SELECT count(*) FROM lms.encroachment x
         WHERE x.province_code = pv.code AND x.stage_code <> 'Resolved')                           AS open_encroachments,
       (SELECT count(*) FROM lms.legal_case x
         WHERE x.province_code = pv.code AND x.stay_order
           AND x.status NOT IN ('Decided — In Favour','Decided — Against','Settled','Withdrawn'))  AS active_stay_orders,
       clock_timestamp() AS computed_at
FROM lms.province pv;

CREATE UNIQUE INDEX province_summary_pk ON lms.province_summary (province_code);
COMMENT ON MATERIALIZED VIEW lms.province_summary IS
  'Executive dashboard aggregates, as at computed_at. Not granted to any '
  'application role: a materialized view has no row-level security, so it is '
  'read through api.v_province_summary_cached, which restates the province scope.';

CREATE VIEW api.v_province_summary_cached AS
SELECT s.*, (now() - s.computed_at) AS age,
       (now() - s.computed_at) > d.max_staleness AS is_overdue
FROM lms.province_summary s
CROSS JOIN lms.derived_refresh d
WHERE d.object_name = 'lms.province_summary'
  AND (lms.actor_role() = 'Admin' OR s.province_code = ANY (lms.actor_provinces()));
COMMENT ON VIEW api.v_province_summary_cached IS
  'The cached dashboard, province-scoped in the view body because the '
  'materialized view underneath cannot be. It reports its own age and whether '
  'that age is past the agreed limit, so a screen can say "as at 09:45" or '
  '"figures are stale" rather than presenting old numbers as current.';
GRANT SELECT ON api.v_province_summary_cached TO lms_readwrite, lms_readonly;

CREATE FUNCTION api.refresh_derived(p_object text DEFAULT NULL) RETURNS TABLE (
         object_name text, refreshed boolean, duration_ms integer, detail text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE r record; t0 timestamptz; v_ms integer;
BEGIN
  -- CONCURRENTLY cannot run inside a transaction block, so this routine must
  -- be called outside one — with autocommit, or from a maintenance script.
  -- The check is explicit rather than left to a confusing error from REFRESH.
  IF (SELECT count(*) FROM pg_stat_activity
      WHERE pid = pg_backend_pid() AND xact_start IS NOT NULL
        AND xact_start < clock_timestamp() - interval '0 second'
        AND state = 'active') > 0
     AND current_setting('transaction_isolation') IS NOT NULL
     AND NOT pg_catalog.pg_is_in_recovery()
     AND (SELECT txid_current_if_assigned() IS NOT NULL) THEN
    RAISE EXCEPTION 'api.refresh_derived() must be called outside a transaction block'
      USING HINT = 'REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside one';
  END IF;

  FOR r IN SELECT d.object_name FROM lms.derived_refresh d
           WHERE p_object IS NULL OR d.object_name = p_object
           ORDER BY d.object_name
  LOOP
    t0 := clock_timestamp();
    BEGIN
      EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %s', r.object_name);
      v_ms := (extract(epoch FROM clock_timestamp() - t0) * 1000)::integer;
      UPDATE lms.derived_refresh
         SET is_stale = false, marked_at = NULL,
             refreshed_at = clock_timestamp(), refresh_ms = v_ms
       WHERE lms.derived_refresh.object_name = r.object_name;
      RETURN QUERY SELECT r.object_name, true, v_ms, 'refreshed'::text;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT r.object_name, false,
        (extract(epoch FROM clock_timestamp() - t0) * 1000)::integer, SQLERRM;
    END;
  END LOOP;
END $$;
COMMENT ON FUNCTION api.refresh_derived(text) IS
  'Refreshes the materialized views CONCURRENTLY, so readers are not blocked. '
  'Must be called outside a transaction block. SECURITY DEFINER because only '
  'the owner may refresh them, and it reports a failure per object rather than '
  'abandoning the rest.';
GRANT EXECUTE ON FUNCTION api.refresh_derived(text) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- Per-case settlement, computed with the indexes rather than with a function
-- call per row.
--
-- LATERAL, not a join to a whole-table aggregate: the outer query always
-- restricts the cases (a province, a stage, a LIMIT), and a LATERAL is
-- evaluated only for the rows that survive that restriction. Joining to a
-- GROUP BY over every allocation in the database would compute 30,000
-- settlements to report 100 — which is what the first version of this did, and
-- what the measurement caught.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.case_settlement(p_case_id uuid)
  RETURNS TABLE (allocated_amount numeric(18,2), released_amount numeric(18,2))
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(sum(al.amount) FILTER (WHERE pr.stage_code NOT IN ('Cancelled','Stopped')), 0)::numeric(18,2),
         coalesce(sum(al.amount) FILTER (WHERE rel.payment_id IS NOT NULL), 0)::numeric(18,2)
  FROM lms.payment_allocation al
  JOIN lms.payment_request pr ON pr.id = al.payment_id
  LEFT JOIN lms.payment_release rel ON rel.payment_id = al.payment_id
  WHERE al.case_id = p_case_id;
$$;
COMMENT ON FUNCTION api.case_settlement(uuid) IS
  'Allocated and released for one case, as a set-returning function so it can '
  'be used in a LATERAL. Backed by payment_allocation_case_idx.';
GRANT EXECUTE ON FUNCTION api.case_settlement(uuid) TO lms_readwrite, lms_readonly;

-- Dropped and recreated rather than replaced: the rewrite changes some column
-- types from an unconstrained numeric to numeric(18,2), and a view's column
-- type cannot be changed in place. Grants are re-applied at the end.
DROP VIEW api.v_outstanding_liability;
CREATE VIEW api.v_outstanding_liability WITH (security_invoker = true) AS
SELECT c.id AS case_id, c.code AS case_code, c.province_code,
       p.code AS project_code, p.name AS project_name,
       c.approved_at, c.total_amount AS approved_amount,
       s.allocated_amount, s.released_amount,
       (c.total_amount - s.released_amount)::numeric(18,2) AS outstanding_amount,
       (current_date - c.approved_at::date) AS days_since_approval,
       CASE WHEN c.total_amount - s.released_amount <= 0 THEN 'settled'
            WHEN s.released_amount = 0                    THEN 'unpaid'
            ELSE 'part paid' END                          AS settlement_status,
       o.payees
FROM lms.compensation_case c
JOIN lms.project p ON p.id = c.project_id
CROSS JOIN LATERAL api.case_settlement(c.id) s
LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT lo.full_name, ', ') AS payees
  FROM lms.case_owner co JOIN lms.landowner lo ON lo.id = co.landowner_id
  WHERE co.case_id = c.id
) o ON true
WHERE c.stage_code = 'HO Approved';

DROP VIEW api.v_case_status;
CREATE VIEW api.v_case_status WITH (security_invoker = true) AS
SELECT c.id AS case_id, c.code AS case_code, c.lease_no, c.province_code,
       p.code AS project_code, p.name AS project_name, c.land_use_code,
       c.case_date, c.effective_date, c.stage_code, st.seq AS stage_seq, c.approved_at,
       c.total_lease_area, c.total_lease_amount, c.total_crop_amount,
       c.total_tree_amount, c.total_misc_amount, c.total_amount,
       api.acre_ghunta(c.total_lease_area) AS lease_area_acre_ghunta,
       o.owner_count, o.owner_codes,
       (current_date - coalesce(t.last_acted, c.case_date)) AS days_at_stage,
       wa.assigned_group                                    AS waiting_on_group,
       s.allocated_amount, s.released_amount,
       (c.total_amount - s.released_amount)::numeric(18,2)  AS outstanding_amount
FROM lms.compensation_case c
JOIN lms.project p ON p.id = c.project_id
JOIN lms.workflow_stage st ON st.workflow_code = 'cases' AND st.code = c.stage_code
CROSS JOIN LATERAL api.case_settlement(c.id) s
LEFT JOIN LATERAL (
  SELECT count(*) AS owner_count,
         string_agg(lo.code::text, ', ' ORDER BY lo.code) AS owner_codes
  FROM lms.case_owner co JOIN lms.landowner lo ON lo.id = co.landowner_id
  WHERE co.case_id = c.id
) o ON true
LEFT JOIN LATERAL (
  SELECT max(wt.acted_at)::date AS last_acted
  FROM lms.workflow_transition wt
  WHERE wt.workflow_code = 'cases' AND wt.record_id = c.id
) t ON true
LEFT JOIN lms.workflow_assignment wa
  ON wa.workflow_code = 'cases' AND wa.record_id = c.id AND wa.closed_at IS NULL;

-- The project register: four correlated subqueries, each scanning a large
-- table once per project, become four aggregates computed once.
--
-- Here a join to a whole-table aggregate IS the right shape, unlike the case
-- views above: the register reports every project in a province, so there is
-- no restriction for a LATERAL to exploit, and one pass over the children
-- beats 400 index lookups.
DROP VIEW api.v_project_land_status;
CREATE VIEW api.v_project_land_status WITH (security_invoker = true) AS
SELECT pr.id AS project_id, pr.code AS project_code, pr.name AS project_name,
       pr.type_code, pr.block, pr.province_code, pr.status,
       au.name AS district_name,
       pr.required_area,
       coalesce(ps.linked_parcels, 0)                         AS linked_parcels,
       coalesce(ps.linked_area, 0)::numeric(14,4)             AS linked_area,
       coalesce(ps.parcels_held, 0)                           AS parcels_held,
       coalesce(cs.live_cases, 0)                             AS live_cases,
       coalesce(cs.approved_cases, 0)                         AS approved_cases,
       coalesce(cs.approved_compensation, 0)::numeric(18,2)   AS approved_compensation,
       coalesce(rl.released_amount, 0)::numeric(18,2)         AS released_amount
FROM lms.project pr
JOIN lms.admin_unit au ON au.id = pr.district_id
LEFT JOIN (
  SELECT ps.project_id, count(*) AS linked_parcels,
         sum(s.total_area) AS linked_area,
         count(*) FILTER (WHERE ls.is_held) AS parcels_held
  FROM lms.project_survey ps
  JOIN lms.survey s ON s.id = ps.survey_id
  JOIN lms.land_status ls ON ls.code = s.status_code
  GROUP BY ps.project_id
) ps ON ps.project_id = pr.id
LEFT JOIN (
  SELECT c.project_id,
         count(*) FILTER (WHERE c.stage_code NOT IN ('Cancelled','Stopped')) AS live_cases,
         count(*) FILTER (WHERE c.stage_code = 'HO Approved')                AS approved_cases,
         sum(c.total_amount) FILTER (WHERE c.stage_code = 'HO Approved')     AS approved_compensation
  FROM lms.compensation_case c GROUP BY c.project_id
) cs ON cs.project_id = pr.id
LEFT JOIN (
  SELECT pq.project_id, sum(rel.released_amount) AS released_amount
  FROM lms.payment_release rel
  JOIN lms.payment_request pq ON pq.id = rel.payment_id
  GROUP BY pq.project_id
) rl ON rl.project_id = pr.id;

-- The compensation summary was the slowest query measured. Rewritten so the
-- province and date filters restrict the set of cases FIRST, and the
-- allocations are aggregated only for those cases.
CREATE OR REPLACE FUNCTION api.report_compensation_summary(
         p_province char(3) DEFAULT NULL,
         p_project  uuid    DEFAULT NULL,
         p_from     date    DEFAULT NULL,
         p_to       date    DEFAULT NULL)
  RETURNS TABLE (
    province_code char(3), province_name text, project_code lms.record_code,
    project_name text, case_count bigint, approved_count bigint,
    lease_amount numeric(18,2), crop_amount numeric(18,2), tree_amount numeric(18,2),
    misc_amount numeric(18,2), total_approved numeric(18,2),
    released_amount numeric(18,2), outstanding_amount numeric(18,2))
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH scoped AS (
    SELECT c.id, c.province_code, c.project_id, c.stage_code, c.total_amount,
           c.total_lease_amount, c.total_crop_amount, c.total_tree_amount,
           c.total_misc_amount
    FROM lms.compensation_case c
    WHERE c.stage_code NOT IN ('Cancelled','Stopped')
      AND (p_province IS NULL OR c.province_code = p_province)
      AND (p_project  IS NULL OR c.project_id = p_project)
      AND (p_from     IS NULL OR c.case_date >= p_from)
      AND (p_to       IS NULL OR c.case_date <= p_to)
  ), released AS (
    SELECT al.case_id, sum(al.amount) AS released_amount
    FROM lms.payment_allocation al
    JOIN scoped sc ON sc.id = al.case_id
    JOIN lms.payment_release rel ON rel.payment_id = al.payment_id
    GROUP BY al.case_id
  )
  SELECT sc.province_code, pv.name, p.code, p.name,
         count(*),
         count(*) FILTER (WHERE sc.stage_code = 'HO Approved'),
         sum(sc.total_lease_amount) FILTER (WHERE sc.stage_code = 'HO Approved'),
         sum(sc.total_crop_amount)  FILTER (WHERE sc.stage_code = 'HO Approved'),
         sum(sc.total_tree_amount)  FILTER (WHERE sc.stage_code = 'HO Approved'),
         sum(sc.total_misc_amount)  FILTER (WHERE sc.stage_code = 'HO Approved'),
         coalesce(sum(sc.total_amount) FILTER (WHERE sc.stage_code = 'HO Approved'), 0),
         coalesce(sum(r.released_amount) FILTER (WHERE sc.stage_code = 'HO Approved'), 0),
         coalesce(sum(sc.total_amount - coalesce(r.released_amount, 0))
                  FILTER (WHERE sc.stage_code = 'HO Approved'), 0)
  FROM scoped sc
  JOIN lms.project p   ON p.id = sc.project_id
  JOIN lms.province pv ON pv.code = sc.province_code
  LEFT JOIN released r ON r.case_id = sc.id
  GROUP BY sc.province_code, pv.name, p.code, p.name
  ORDER BY sc.province_code, p.code;
$$;

-- The three rewritten views were dropped, so their grants went with them.
GRANT SELECT ON api.v_outstanding_liability, api.v_case_status,
                api.v_project_land_status TO lms_readwrite, lms_readonly;

-- Statistics have to be current for any of this to be used.
ANALYZE lms.landowner, lms.payment_request, lms.payment_allocation,
        lms.payment_release, lms.compensation_case, lms.case_lease_line,
        lms.survey, lms.survey_ownership_share, lms.lease, lms.project,
        lms.admin_unit, lms.grievance, lms.encroachment, audit.audit_event;

-- This migration creates three routines, and a new routine is executable by
-- PUBLIC unless something says otherwise. See the note in migration 0001 for
-- why the default-privileges approach does not work and why every migration
-- that adds a routine has to end this way.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lms, api, audit, util FROM PUBLIC;
