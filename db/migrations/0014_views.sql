-- =====================================================================
-- 0014  Reporting and operational views
-- =====================================================================
-- Every view here is declared WITH (security_invoker = true), which
-- PostgreSQL 15 introduced and this deployment (16.13) supports.
--
-- Why that matters: a view normally reads its base tables with the privileges
-- and the row-level security context of the VIEW'S OWNER, not of the caller.
-- Since these views are owned by lms_owner — which owns the tables and
-- therefore bypasses their policies — a plain view would hand every caller
-- every province's rows, no matter what the policies on lms.survey said. The
-- underlying tables being restricted would not save us: the view would be the
-- way around the restriction.
--
-- security_invoker = true makes each view read its base tables as the caller,
-- so the policies apply and a Sindh account sees Sindh rows through the view
-- exactly as it would through the table. db/tests/test_05_views_rls.sql proves
-- this by querying each view as two differently-scoped roles and comparing.
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Land and ownership
-- ---------------------------------------------------------------------
CREATE VIEW api.v_admin_unit_path WITH (security_invoker = true) AS
WITH RECURSIVE t AS (
  SELECT u.id, u.province_code, u.level, u.parent_id, u.name, u.code,
         u.name::text AS path, u.id AS root_id
  FROM lms.admin_unit u WHERE u.parent_id IS NULL
  UNION ALL
  SELECT u.id, u.province_code, u.level, u.parent_id, u.name, u.code,
         t.path || ' → ' || u.name, t.root_id
  FROM lms.admin_unit u JOIN t ON t.id = u.parent_id
)
SELECT id AS admin_unit_id, code, province_code, level, parent_id, name, path, root_id AS district_id
FROM t;
COMMENT ON VIEW api.v_admin_unit_path IS
  'Every administrative unit with its full "District → Taluka → Deh" path. '
  'Recursive, so it works for the three-level Sindh tree and the five-level '
  'Balochistan one without a per-province query.';

CREATE VIEW api.v_survey_ownership WITH (security_invoker = true) AS
SELECT s.id AS survey_id, s.code AS survey_code, s.province_code,
       p.name AS province_name,
       s.survey_no, s.block_no, s.khasra_type,
       up.path AS location_path,
       s.total_area, s.land_class, s.status_code,
       coalesce(sum(sh.share_pct), 0)::numeric(9,4) AS share_total_pct,
       count(sh.id)                                  AS owner_count,
       -- A parcel is "fully apportioned" at exactly 100%. Under is common
       -- (incomplete revenue records); over is a data error.
       CASE WHEN coalesce(sum(sh.share_pct),0) > 100     THEN 'over-apportioned'
            WHEN coalesce(sum(sh.share_pct),0) = 100     THEN 'complete'
            WHEN coalesce(sum(sh.share_pct),0) = 0       THEN 'no ownership recorded'
            ELSE 'partial' END                        AS apportionment,
       -- Committed area across live compensation cases.
       coalesce((SELECT sum(coalesce(l.subsequent_area, l.lease_area))
                 FROM lms.case_lease_line l
                 JOIN lms.compensation_case c ON c.id = l.case_id
                 WHERE l.survey_id = s.id
                   AND c.stage_code NOT IN ('Cancelled','Stopped')), 0)::numeric(14,4)
                                                     AS committed_area
FROM lms.survey s
JOIN lms.province p ON p.code = s.province_code
LEFT JOIN api.v_admin_unit_path up ON up.admin_unit_id = s.admin_unit_id
LEFT JOIN lms.survey_ownership_share sh ON sh.survey_id = s.id
GROUP BY s.id, s.code, s.province_code, p.name, s.survey_no, s.block_no,
         s.khasra_type, up.path, s.total_area, s.land_class, s.status_code;

CREATE VIEW api.v_landowner_summary WITH (security_invoker = true) AS
SELECT lo.id AS landowner_id, lo.code AS landowner_code, lo.province_code,
       lo.full_name, lo.father_name, lo.cnic, lo.phone,
       lo.owner_type, lo.status, lo.tax_status, lo.bank_branch,
       count(DISTINCT sh.survey_id)                                   AS holding_count,
       coalesce(sum(s.total_area * sh.share_pct / 100), 0)::numeric(14,4) AS owned_area_acres,
       (SELECT count(*) FROM lms.lease_lessor ll
          JOIN lms.lease l ON l.id = ll.lease_id
         WHERE ll.landowner_id = lo.id
           AND l.stage_code = 'Approved' AND l.terminated_on IS NULL
           AND l.end_date >= current_date)                            AS active_lease_count,
       -- Paid to date reads the release ledger, not a payment stage.
       coalesce((SELECT sum(r.released_amount)
                 FROM lms.payment_release r
                 JOIN lms.payment_request pr ON pr.id = r.payment_id
                 WHERE pr.landowner_id = lo.id), 0)::numeric(18,2)    AS paid_to_date,
       EXISTS (SELECT 1 FROM lms.payment_hold h
               WHERE h.scope = 'landowner' AND h.landowner_id = lo.id
                 AND h.lifted_at IS NULL)                             AS is_on_hold
FROM lms.landowner lo
LEFT JOIN lms.survey_ownership_share sh ON sh.landowner_id = lo.id
LEFT JOIN lms.survey s ON s.id = sh.survey_id
GROUP BY lo.id, lo.code, lo.province_code, lo.full_name, lo.father_name, lo.cnic,
         lo.phone, lo.owner_type, lo.status, lo.tax_status, lo.bank_branch;
COMMENT ON VIEW api.v_landowner_summary IS
  'owned_area_acres is each parcel''s area weighted by the share held, so a '
  '50% share of a 10-acre parcel counts as 5 acres.';

CREATE VIEW api.v_project_land_status WITH (security_invoker = true) AS
SELECT pr.id AS project_id, pr.code AS project_code, pr.name AS project_name,
       pr.type_code, pr.block, pr.province_code, pr.status,
       au.name AS district_name,
       pr.required_area,
       count(DISTINCT ps.survey_id)                                      AS linked_parcels,
       coalesce(sum(DISTINCT s.total_area), 0)::numeric(14,4)            AS linked_area,
       count(DISTINCT ps.survey_id) FILTER (WHERE ls.is_held)            AS parcels_held,
       (SELECT count(*) FROM lms.compensation_case c
         WHERE c.project_id = pr.id AND c.stage_code NOT IN ('Cancelled','Stopped'))
                                                                         AS live_cases,
       (SELECT count(*) FROM lms.compensation_case c
         WHERE c.project_id = pr.id AND c.stage_code = 'HO Approved')     AS approved_cases,
       (SELECT coalesce(sum(c.total_amount),0) FROM lms.compensation_case c
         WHERE c.project_id = pr.id AND c.stage_code = 'HO Approved')     AS approved_compensation,
       (SELECT coalesce(sum(rel.released_amount),0)
          FROM lms.payment_release rel
          JOIN lms.payment_request pq ON pq.id = rel.payment_id
         WHERE pq.project_id = pr.id)                                    AS released_amount
FROM lms.project pr
JOIN lms.admin_unit au ON au.id = pr.district_id
LEFT JOIN lms.project_survey ps ON ps.project_id = pr.id
LEFT JOIN lms.survey s ON s.id = ps.survey_id
LEFT JOIN lms.land_status ls ON ls.code = s.status_code
GROUP BY pr.id, pr.code, pr.name, pr.type_code, pr.block, pr.province_code,
         pr.status, au.name, pr.required_area;

-- ---------------------------------------------------------------------
-- Leases, renewals, expiry
-- ---------------------------------------------------------------------
CREATE VIEW api.v_lease_register WITH (security_invoker = true) AS
SELECT l.id AS lease_id, l.code AS lease_code, l.province_code,
       p.code AS project_code, p.name AS project_name,
       cc.code AS case_code,
       l.kind, l.registration_no,
       l.initial_area, coalesce(l.subsequent_area, l.initial_area) AS current_area,
       l.start_date, l.term_years, l.end_date, l.terminated_on,
       l.rate_per_acre, l.escalation_pct, l.auto_extend, l.stage_code,
       -- Annual rent on the area currently leased.
       round(l.rate_per_acre * coalesce(l.subsequent_area, l.initial_area), 2) AS annual_rent,
       (l.end_date - current_date)                                  AS days_to_expiry,
       CASE WHEN l.terminated_on IS NOT NULL             THEN 'Terminated'
            WHEN l.stage_code <> 'Approved'              THEN l.stage_code
            WHEN l.end_date < current_date               THEN 'Expired'
            WHEN l.end_date <= current_date + 30          THEN 'Expiring ≤ 30 days'
            WHEN l.end_date <= current_date + 60          THEN 'Expiring ≤ 60 days'
            WHEN l.end_date <= current_date + 90          THEN 'Expiring ≤ 90 days'
            WHEN l.end_date <= current_date + 180         THEN 'Expiring ≤ 180 days'
            ELSE 'Active' END                                       AS lease_status,
       (SELECT count(*) FROM lms.lease_renewal rn WHERE rn.lease_id = l.id) AS renewal_count,
       (SELECT string_agg(lo.full_name, ', ' ORDER BY lo.full_name)
          FROM lms.lease_lessor ll JOIN lms.landowner lo ON lo.id = ll.landowner_id
         WHERE ll.lease_id = l.id)                                  AS lessors,
       (SELECT string_agg(s.code::text, ', ' ORDER BY s.code)
          FROM lms.lease_survey lsv JOIN lms.survey s ON s.id = lsv.survey_id
         WHERE lsv.lease_id = l.id)                                 AS parcels
FROM lms.lease l
JOIN lms.project p ON p.id = l.project_id
LEFT JOIN lms.compensation_case cc ON cc.id = l.case_id;
COMMENT ON VIEW api.v_lease_register IS
  'The lease register with the 180/90/60/30-day expiry bands the client''s '
  'alerting is specified in.';

CREATE VIEW api.v_lease_expiry_alert WITH (security_invoker = true) AS
SELECT lease_id, lease_code, province_code, project_code, lessors, parcels,
       end_date, days_to_expiry, annual_rent, lease_status,
       CASE WHEN days_to_expiry < 0   THEN 'urgent'
            WHEN days_to_expiry <= 30 THEN 'urgent'
            WHEN days_to_expiry <= 90 THEN 'high'
            ELSE 'normal' END AS urgency
FROM api.v_lease_register
WHERE terminated_on IS NULL
  AND stage_code = 'Approved'
  AND end_date <= current_date + 180;

CREATE VIEW api.v_row_renewal_schedule WITH (security_invoker = true) AS
SELECT rc.id AS row_id, rc.code AS row_code, rc.province_code,
       p.code AS project_code, rc.name AS segment_name, rc.row_type,
       rc.length_m, rc.width_m, rc.area_acres,
       rc.agreement_date, rc.tenure_years, rc.annual_rent, rc.stage_code,
       (rc.agreement_date + make_interval(years => rc.tenure_years::int))::date AS tenure_end,
       -- ROW rent is paid yearly on the agreement anniversary. The next one is
       -- this year's anniversary if it is still ahead, otherwise next year's.
       (rc.agreement_date + make_interval(years =>
          (date_part('year', current_date) - date_part('year', rc.agreement_date)
           + CASE WHEN (rc.agreement_date
                        + make_interval(years => (date_part('year', current_date)
                                                  - date_part('year', rc.agreement_date))::int))::date
                       < current_date THEN 1 ELSE 0 END)::int))::date AS next_renewal_date,
       (SELECT count(*) FROM lms.encroachment e
         WHERE e.row_id = rc.id AND e.stage_code <> 'Resolved')         AS open_violations
FROM lms.row_corridor rc
JOIN lms.project p ON p.id = rc.project_id;

-- ---------------------------------------------------------------------
-- Compensation cases and approval bottlenecks
-- ---------------------------------------------------------------------
CREATE VIEW api.v_case_status WITH (security_invoker = true) AS
SELECT c.id AS case_id, c.code AS case_code, c.lease_no, c.province_code,
       p.code AS project_code, p.name AS project_name, c.land_use_code,
       c.case_date, c.effective_date, c.stage_code, st.seq AS stage_seq, c.approved_at,
       c.total_lease_area, c.total_lease_amount, c.total_crop_amount,
       c.total_tree_amount, c.total_misc_amount, c.total_amount,
       api.acre_ghunta(c.total_lease_area) AS lease_area_acre_ghunta,
       (SELECT count(*) FROM lms.case_owner o WHERE o.case_id = c.id)      AS owner_count,
       (SELECT string_agg(lo.code::text, ', ' ORDER BY lo.code)
          FROM lms.case_owner o JOIN lms.landowner lo ON lo.id = o.landowner_id
         WHERE o.case_id = c.id)                                          AS owner_codes,
       -- Days the case has been sitting at its current stage: the number the
       -- bottleneck report is built on.
       (current_date - coalesce((SELECT max(t.acted_at)::date
                                 FROM lms.workflow_transition t
                                 WHERE t.workflow_code = 'cases' AND t.record_id = c.id),
                                c.case_date))                             AS days_at_stage,
       (SELECT wa.assigned_group FROM lms.workflow_assignment wa
         WHERE wa.workflow_code = 'cases' AND wa.record_id = c.id AND wa.closed_at IS NULL
         LIMIT 1)                                                         AS waiting_on_group,
       lia.allocated_amount, lia.released_amount, lia.outstanding_amount
FROM lms.compensation_case c
JOIN lms.project p ON p.id = c.project_id
JOIN lms.workflow_stage st ON st.workflow_code = 'cases' AND st.code = c.stage_code
CROSS JOIN LATERAL api.case_liability(c.id) lia;

CREATE VIEW api.v_approval_bottleneck WITH (security_invoker = true) AS
SELECT wf.code AS workflow_code, wf.label AS workflow_label,
       wa.stage_code, wa.assigned_group, rec.province_code,
       count(*)                                        AS waiting_count,
       min(wa.assigned_at)                             AS oldest_assigned_at,
       round(avg(extract(epoch FROM (now() - wa.assigned_at)) / 86400)::numeric, 1)
                                                       AS avg_days_waiting,
       max(extract(epoch FROM (now() - wa.assigned_at)) / 86400)::integer
                                                       AS max_days_waiting,
       count(*) FILTER (WHERE wa.due_at < now())        AS overdue_count
FROM lms.workflow_assignment wa
JOIN lms.workflow wf ON wf.code = wa.workflow_code
JOIN LATERAL (
  SELECT t.province_code
  FROM lms.workflow_transition t
  WHERE t.workflow_code = wa.workflow_code AND t.record_id = wa.record_id
  ORDER BY t.acted_at DESC LIMIT 1
) rec ON true
WHERE wa.closed_at IS NULL
GROUP BY wf.code, wf.label, wa.stage_code, wa.assigned_group, rec.province_code;
COMMENT ON VIEW api.v_approval_bottleneck IS
  'Open approval queues by workflow, stage, position and province, with how '
  'long the oldest item has been waiting. Answers "where is work piling up".';

-- ---------------------------------------------------------------------
-- Payments, liabilities, reconciliation
-- ---------------------------------------------------------------------
CREATE VIEW api.v_payment_release WITH (security_invoker = true) AS
SELECT r.id AS release_id, pr.id AS payment_id, pr.code AS voucher_code,
       pr.province_code, p.code AS project_code,
       coalesce(lo.full_name, pr.payee_name) AS payee,
       lo.code AS landowner_code, lo.cnic,
       pr.category_code, pr.pay_type, pr.period_from, pr.period_to,
       pr.gross_amount, pr.wht_amount, pr.net_amount,
       r.cheque_no, r.cheque_date, r.released_amount, r.released_at,
       u.username AS released_by,
       (SELECT count(*) FROM lms.payment_receipt rc WHERE rc.release_id = r.id) AS receipt_count,
       cc.code AS case_code, l.code AS lease_code
FROM lms.payment_release r
JOIN lms.payment_request pr ON pr.id = r.payment_id
JOIN lms.project p ON p.id = pr.project_id
JOIN lms.app_user u ON u.id = r.released_by
LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
LEFT JOIN lms.compensation_case cc ON cc.id = pr.case_id
LEFT JOIN lms.lease l ON l.id = pr.lease_id;

CREATE VIEW api.v_outstanding_liability WITH (security_invoker = true) AS
SELECT c.id AS case_id, c.code AS case_code, c.province_code,
       p.code AS project_code, p.name AS project_name,
       c.approved_at, c.total_amount AS approved_amount,
       lia.allocated_amount, lia.released_amount, lia.outstanding_amount,
       (current_date - c.approved_at::date) AS days_since_approval,
       CASE WHEN lia.outstanding_amount <= 0                       THEN 'settled'
            WHEN lia.released_amount = 0                            THEN 'unpaid'
            ELSE 'part paid' END                                   AS settlement_status,
       (SELECT string_agg(DISTINCT lo.full_name, ', ')
          FROM lms.case_owner o JOIN lms.landowner lo ON lo.id = o.landowner_id
         WHERE o.case_id = c.id)                                   AS payees
FROM lms.compensation_case c
JOIN lms.project p ON p.id = c.project_id
CROSS JOIN LATERAL api.case_liability(c.id) lia
WHERE c.stage_code = 'HO Approved';
COMMENT ON VIEW api.v_outstanding_liability IS
  'Approved compensation not yet paid. The liability register: what the '
  'company owes landowners today.';

CREATE VIEW api.v_reconciliation_exception WITH (security_invoker = true) AS
SELECT e.id, e.run_id, r.as_of, r.scope, e.kind, e.severity,
       e.entity, e.entity_id, e.entity_code, e.province_code,
       e.expected, e.actual, e.difference, e.detail,
       e.resolved_at, u.username AS resolved_by, e.resolution
FROM lms.reconciliation_exception e
JOIN lms.reconciliation_run r ON r.id = e.run_id
LEFT JOIN lms.app_user u ON u.id = e.resolved_by;

CREATE VIEW api.v_budget_utilisation WITH (security_invoker = true) AS
SELECT b.id AS budget_id, b.code AS budget_code, b.province_code,
       p.code AS project_code, p.name AS project_name, b.fiscal_year,
       pos.approved_amount, pos.released_amount, pos.committed_amount,
       pos.balance_amount, pos.utilisation_pct,
       CASE WHEN pos.balance_amount < 0        THEN 'over budget'
            WHEN pos.utilisation_pct > 85      THEN 'nearly committed'
            ELSE 'within budget' END AS budget_status
FROM lms.budget b
JOIN lms.project p ON p.id = b.project_id
CROSS JOIN LATERAL api.budget_status(b.project_id, b.fiscal_year) pos;

CREATE VIEW api.v_dbpfc_summary WITH (security_invoker = true) AS
SELECT d.id AS dbpfc_id, d.code AS dbpfc_code, d.province_code,
       p.code AS project_code, au.name AS district_name,
       d.area_acres, d.estimated_rate, d.fixed_rate, d.applied_rate, d.annual_amount,
       d.committee_ref, d.meeting_date, d.stage_code,
       (d.fixed_rate IS NOT NULL) AS rate_is_fixed,
       (SELECT count(*) FROM lms.dbpfc_rate_history h WHERE h.dbpfc_id = d.id) AS rate_revisions,
       (SELECT string_agg(s.code::text, ', ' ORDER BY s.code)
          FROM lms.dbpfc_survey ds JOIN lms.survey s ON s.id = ds.survey_id
         WHERE ds.dbpfc_id = d.id) AS parcels,
       coalesce((SELECT sum(r.released_amount)
                 FROM lms.payment_release r
                 JOIN lms.payment_request pq ON pq.id = r.payment_id
                 WHERE pq.dbpfc_id = d.id), 0)::numeric(18,2) AS paid_amount
FROM lms.dbpfc_estimate d
JOIN lms.project p ON p.id = d.project_id
JOIN lms.admin_unit au ON au.id = d.district_id;

-- ---------------------------------------------------------------------
-- Grievances, encroachments, ROW
-- ---------------------------------------------------------------------
CREATE VIEW api.v_grievance_status WITH (security_invoker = true) AS
SELECT g.id AS grievance_id, g.code AS grievance_code, g.province_code,
       g.grievance_type, g.category_code, g.severity, g.channel,
       coalesce(lo.full_name, g.complainant) AS complainant,
       lo.code AS landowner_code,
       p.code AS project_code, s.code AS survey_code,
       g.received_date, g.due_date, g.resolved_on, g.stage_code, g.escalation_level,
       u.username AS assigned_to,
       (coalesce(g.resolved_on, current_date) - g.received_date) AS age_days,
       (g.resolved_on IS NULL AND g.due_date < current_date)      AS is_overdue
FROM lms.grievance g
LEFT JOIN lms.landowner lo ON lo.id = g.landowner_id
LEFT JOIN lms.project p ON p.id = g.project_id
LEFT JOIN lms.survey s ON s.id = g.survey_id
LEFT JOIN lms.app_user u ON u.id = g.assigned_to;

CREATE VIEW api.v_encroachment_status WITH (security_invoker = true) AS
SELECT e.id AS encroachment_id, e.code AS encroachment_code, e.province_code,
       e.category_code, e.risk, e.lat, e.lng, e.detected_on, e.resolved_on,
       e.stage_code, e.escalation_level, e.area_affected, e.encroacher,
       p.code AS project_code, s.code AS survey_code, rc.code AS row_code,
       (coalesce(e.resolved_on, current_date) - e.detected_on) AS age_days,
       (SELECT count(*) FROM lms.document d
         WHERE d.entity = 'encroachment' AND d.record_id = e.id AND d.deleted_at IS NULL)
                                                               AS evidence_count
FROM lms.encroachment e
JOIN lms.project p ON p.id = e.project_id
LEFT JOIN lms.survey s ON s.id = e.survey_id
LEFT JOIN lms.row_corridor rc ON rc.id = e.row_id;

-- ---------------------------------------------------------------------
-- Audit and version history
-- ---------------------------------------------------------------------
CREATE VIEW api.v_audit_trail WITH (security_invoker = true) AS
SELECT a.id, a.occurred_at, a.actor_username, a.actor_role, a.db_role,
       a.entity, a.record_id, a.record_code, a.province_code, a.action,
       a.changed_fields, a.note, a.txid,
       -- A readable diff of the changed fields only.
       (SELECT jsonb_object_agg(k, jsonb_build_object('from', a.old_data -> k, 'to', a.new_data -> k))
          FROM unnest(coalesce(a.changed_fields, '{}'::text[])) AS k) AS changes
FROM audit.audit_event a;
COMMENT ON VIEW api.v_audit_trail IS
  'The audit trail with a field-level diff. security_invoker, so an account '
  'sees only trail entries for provinces it may see.';

CREATE VIEW api.v_record_version_history WITH (security_invoker = true) AS
SELECT v.id, v.entity, v.record_id, v.version, v.province_code, v.valid_from,
       u.username AS created_by_username, v.snapshot,
       lead(v.valid_from) OVER (PARTITION BY v.entity, v.record_id ORDER BY v.version) AS valid_to
FROM audit.record_version v
JOIN lms.app_user u ON u.id = v.created_by;

-- ---------------------------------------------------------------------
-- Executive dashboard
-- ---------------------------------------------------------------------
CREATE VIEW api.v_province_summary WITH (security_invoker = true) AS
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
           AND x.status NOT IN ('Decided — In Favour','Decided — Against','Settled','Withdrawn'))  AS active_stay_orders
FROM lms.province pv;
COMMENT ON VIEW api.v_province_summary IS
  'Province-wise KPI row for the executive dashboard. security_invoker, so an '
  'account with access to one province sees its own figures and zeroes '
  'elsewhere rather than the whole company''s.';
