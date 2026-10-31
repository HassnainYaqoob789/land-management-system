-- =====================================================================
-- 0031  Complete coverage fixes: analytics view accuracy, Cartesian
--       fan-out elimination, multi-scope hold resolution, and IAM
--       permissions for all operational & compliance modules
-- =====================================================================
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- 1. Fix api.v_executive_kpis: total_approved_compensation sums ONLY
--    stage_code = 'HO Approved' cases so Draft/Pending/Cancelled cases
--    do not inflate approved compensation or outstanding liability.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW api.v_executive_kpis WITH (security_invoker = true) AS
WITH proj_stats AS (
  SELECT
    count(DISTINCT id) AS total_projects,
    count(DISTINCT CASE WHEN status = 'Active' THEN id END) AS active_projects
  FROM lms.project
),
parcel_stats AS (
  SELECT
    count(DISTINCT id) AS total_parcels,
    COALESCE(sum(total_area), 0) AS total_acres,
    count(DISTINCT CASE WHEN land_class = 'Government' THEN id END) AS gov_parcels,
    COALESCE(sum(CASE WHEN land_class = 'Government' THEN total_area ELSE 0 END), 0) AS gov_acres,
    count(DISTINCT CASE WHEN status_code = 'Acquired' THEN id END) AS acquired_parcels,
    COALESCE(sum(CASE WHEN status_code = 'Acquired' THEN total_area ELSE 0 END), 0) AS acquired_acres,
    count(DISTINCT CASE WHEN status_code = 'Leased' THEN id END) AS leased_parcels,
    COALESCE(sum(CASE WHEN status_code = 'Leased' THEN total_area ELSE 0 END), 0) AS leased_acres
  FROM lms.survey
),
owner_stats AS (
  SELECT
    count(DISTINCT id) AS total_landowners,
    count(DISTINCT CASE WHEN cnic IS NOT NULL AND cnic != '' THEN id END) AS cnic_verified_owners
  FROM lms.landowner
),
comp_stats AS (
  SELECT
    COALESCE(sum(CASE WHEN stage_code = 'HO Approved' THEN total_amount ELSE 0 END), 0) AS total_approved_compensation,
    count(DISTINCT id) AS total_cases,
    count(DISTINCT CASE WHEN stage_code = 'HO Approved' THEN id END) AS approved_cases,
    count(DISTINCT CASE WHEN stage_code NOT IN ('HO Approved', 'Cancelled') THEN id END) AS pending_cases
  FROM lms.compensation_case
),
pay_stats AS (
  SELECT
    COALESCE(sum(CASE WHEN stage_code = 'Released' THEN net_amount ELSE 0 END), 0) AS total_compensation_paid,
    COALESCE(sum(CASE WHEN stage_code IN ('Requested', 'Verified', 'Approved') THEN net_amount ELSE 0 END), 0) AS pending_payments,
    count(DISTINCT CASE WHEN stage_code = 'Released' THEN id END) AS paid_cheques_count
  FROM lms.payment_request
),
lease_stats AS (
  SELECT
    count(DISTINCT id) AS total_leases,
    count(DISTINCT CASE WHEN end_date < CURRENT_DATE THEN id END) AS expired_leases,
    count(DISTINCT CASE WHEN end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + interval '90 days') THEN id END) AS expiring_90d_leases,
    count(DISTINCT CASE WHEN is_on_hold = true THEN id END) AS hold_leases
  FROM lms.lease
),
risk_stats AS (
  SELECT
    count(DISTINCT id) AS total_grievances,
    count(DISTINCT CASE WHEN stage_code NOT IN ('Resolved', 'Closed') THEN id END) AS open_grievances
  FROM lms.grievance
),
stay_stats AS (
  SELECT count(DISTINCT id) AS active_stay_orders FROM lms.legal_case WHERE stay_order = true
),
gis_stats AS (
  SELECT count(DISTINCT id) AS mapped_features FROM lms.project_spatial_feature
)
SELECT
  proj_stats.total_projects,
  proj_stats.active_projects,
  parcel_stats.total_parcels,
  parcel_stats.total_acres,
  parcel_stats.gov_parcels,
  parcel_stats.gov_acres,
  parcel_stats.acquired_parcels,
  parcel_stats.acquired_acres,
  parcel_stats.leased_parcels,
  parcel_stats.leased_acres,
  owner_stats.total_landowners,
  owner_stats.cnic_verified_owners,
  comp_stats.total_approved_compensation,
  comp_stats.total_cases,
  comp_stats.approved_cases,
  comp_stats.pending_cases,
  pay_stats.total_compensation_paid,
  pay_stats.pending_payments,
  GREATEST(0, comp_stats.total_approved_compensation - pay_stats.total_compensation_paid) AS outstanding_liability,
  lease_stats.total_leases,
  lease_stats.expired_leases,
  lease_stats.expiring_90d_leases,
  lease_stats.hold_leases,
  risk_stats.open_grievances,
  stay_stats.active_stay_orders,
  gis_stats.mapped_features
FROM proj_stats, parcel_stats, owner_stats, comp_stats, pay_stats, lease_stats, risk_stats, stay_stats, gis_stats;

-- ---------------------------------------------------------------------
-- 2. Fix api.v_project_portfolio: replace 7-table LEFT JOIN fan-out
--    with pre-aggregated CTEs so sum(total_area), sum(total_amount),
--    and sum(net_amount) are never multiplied across dimensions.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW api.v_project_portfolio WITH (security_invoker = true) AS
WITH sv AS (
  SELECT
    ps.project_id,
    count(DISTINCT ps.survey_id)::bigint AS parcel_count,
    COALESCE(sum(s.total_area), 0)::numeric AS total_area_acres,
    COALESCE(sum(CASE WHEN s.land_class = 'Government' THEN s.total_area ELSE 0 END), 0)::numeric AS gov_area_acres,
    COALESCE(sum(CASE WHEN s.status_code = 'Acquired' THEN s.total_area ELSE 0 END), 0)::numeric AS acquired_area_acres,
    COALESCE(sum(CASE WHEN s.status_code = 'Leased' THEN s.total_area ELSE 0 END), 0)::numeric AS leased_area_acres
  FROM lms.project_survey ps
  JOIN lms.survey s ON s.id = ps.survey_id
  GROUP BY ps.project_id
),
own AS (
  SELECT
    ps.project_id,
    count(DISTINCT o.landowner_id)::bigint AS landowner_count
  FROM lms.project_survey ps
  JOIN lms.survey_ownership_share o ON o.survey_id = ps.survey_id
  GROUP BY ps.project_id
),
cs AS (
  SELECT
    c.project_id,
    count(DISTINCT c.id)::bigint AS case_count,
    COALESCE(sum(CASE WHEN c.stage_code = 'HO Approved' THEN c.total_amount ELSE 0 END), 0)::numeric AS approved_compensation
  FROM lms.compensation_case c
  GROUP BY c.project_id
),
py AS (
  SELECT
    pay.project_id,
    COALESCE(sum(CASE WHEN pay.stage_code = 'Released' THEN pay.net_amount ELSE 0 END), 0)::numeric AS paid_compensation
  FROM lms.payment_request pay
  GROUP BY pay.project_id
),
ls AS (
  SELECT
    l.project_id,
    count(DISTINCT l.id)::bigint AS lease_count,
    count(DISTINCT CASE WHEN l.end_date < CURRENT_DATE THEN l.id END)::bigint AS expired_lease_count,
    count(DISTINCT CASE WHEN l.end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + interval '90 days') THEN l.id END)::bigint AS expiring_lease_count
  FROM lms.lease l
  GROUP BY l.project_id
),
ft AS (
  SELECT
    feat.project_id,
    count(DISTINCT feat.id)::bigint AS gis_feature_count
  FROM lms.project_spatial_feature feat
  GROUP BY feat.project_id
)
SELECT
  p.id AS project_id,
  p.code AS project_code,
  p.name AS project_name,
  p.province_code,
  p.status AS project_status,
  p.created_at AS project_created_at,
  COALESCE(sv.parcel_count, 0)::bigint AS parcel_count,
  COALESCE(sv.total_area_acres, 0)::numeric AS total_area_acres,
  COALESCE(sv.gov_area_acres, 0)::numeric AS gov_area_acres,
  COALESCE(sv.acquired_area_acres, 0)::numeric AS acquired_area_acres,
  COALESCE(sv.leased_area_acres, 0)::numeric AS leased_area_acres,
  COALESCE(own.landowner_count, 0)::bigint AS landowner_count,
  COALESCE(cs.case_count, 0)::bigint AS case_count,
  COALESCE(cs.approved_compensation, 0)::numeric AS approved_compensation,
  COALESCE(py.paid_compensation, 0)::numeric AS paid_compensation,
  GREATEST(0::numeric, COALESCE(cs.approved_compensation, 0) - COALESCE(py.paid_compensation, 0))::numeric AS outstanding_liability,
  COALESCE(ls.lease_count, 0)::bigint AS lease_count,
  COALESCE(ls.expired_lease_count, 0)::bigint AS expired_lease_count,
  COALESCE(ls.expiring_lease_count, 0)::bigint AS expiring_lease_count,
  COALESCE(ft.gis_feature_count, 0)::bigint AS gis_feature_count
FROM lms.project p
LEFT JOIN sv  ON sv.project_id  = p.id
LEFT JOIN own ON own.project_id = p.id
LEFT JOIN cs  ON cs.project_id  = p.id
LEFT JOIN py  ON py.project_id  = p.id
LEFT JOIN ls  ON ls.project_id  = p.id
LEFT JOIN ft  ON ft.project_id  = p.id;

-- ---------------------------------------------------------------------
-- 3. Fix api.v_finance_aging: exclude Released/Cancelled/Stopped
--    vouchers from pending aging liabilities, and detect active holds
--    across all 5 hold scopes (payment, case, landowner, project, survey).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW api.v_finance_aging WITH (security_invoker = true) AS
SELECT
  pr.id AS payment_id,
  pr.code AS payment_code,
  pr.province_code,
  pr.project_id,
  p.name AS project_name,
  pr.landowner_id,
  lo.full_name AS landowner_name,
  lo.cnic AS landowner_cnic,
  pr.case_id,
  c.code AS case_code,
  pr.category_code AS payment_category,
  pr.gross_amount,
  pr.wht_amount,
  pr.net_amount,
  pr.stage_code AS payment_status,
  CASE WHEN ph.id IS NOT NULL THEN true ELSE false END AS is_on_hold,
  ph.reason AS hold_reason,
  pr.created_at AS request_date,
  (CURRENT_DATE - pr.created_at::date)::integer AS days_pending,
  CASE
    WHEN (CURRENT_DATE - pr.created_at::date) <= 30 THEN '0-30 Days'
    WHEN (CURRENT_DATE - pr.created_at::date) <= 60 THEN '31-60 Days'
    WHEN (CURRENT_DATE - pr.created_at::date) <= 90 THEN '61-90 Days'
    ELSE 'Over 90 Days'
  END AS aging_bracket
FROM lms.payment_request pr
LEFT JOIN lms.project p ON p.id = pr.project_id
LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
LEFT JOIN lms.compensation_case c ON c.id = pr.case_id
LEFT JOIN LATERAL (
  SELECT h.id, h.reason
  FROM lms.payment_hold h
  WHERE h.lifted_at IS NULL
    AND (
      (h.scope = 'payment'   AND h.payment_id   = pr.id)
      OR (h.scope = 'case'      AND h.case_id      = pr.case_id)
      OR (h.scope = 'landowner' AND h.landowner_id = pr.landowner_id)
      OR (h.scope = 'project'   AND h.project_id   = pr.project_id)
      OR (h.scope = 'survey'    AND (
        EXISTS (SELECT 1 FROM lms.case_lease_line cl WHERE cl.case_id = pr.case_id AND cl.survey_id = h.survey_id)
        OR EXISTS (SELECT 1 FROM lms.lease_survey ls WHERE ls.lease_id = pr.lease_id AND ls.survey_id = h.survey_id)
      ))
    )
  ORDER BY h.placed_at DESC
  LIMIT 1
) ph ON true
WHERE pr.stage_code NOT IN ('Released', 'Cancelled', 'Stopped');

GRANT SELECT ON api.v_executive_kpis, api.v_project_portfolio, api.v_finance_aging TO lms_readwrite;

-- ---------------------------------------------------------------------
-- 4. Expand IAM permission catalogue for newly wired operational,
--    legal, compliance, import, inbox, and configuration modules
-- ---------------------------------------------------------------------
INSERT INTO iam.permission(resource, action, description, is_sensitive) VALUES
  ('projects','update','Edit projects and linked surveys',false),
  ('landowners','update','Edit landowner details, bank and tax status',false),
  ('cases','update','Edit compensation case lines and checklists',false),
  ('rows','update','Update ROW corridors and advance workflow',false),
  ('dbpfc','create','Create DBPFC land rate estimates',false),
  ('dbpfc','update','Update DBPFC rate fixation and advance workflow',false),
  ('payments','update','Allocate payments, manage holds, record receipts and reconcile',true),
  ('acquisitions','read','View LAA 1894 acquisitions and title checklists',false),
  ('acquisitions','create','Initiate LAA 1894 land acquisitions',false),
  ('acquisitions','update','Update title checklists and advance acquisition workflow',false),
  ('mutations','read','View mutations and succession (Intiqal / Wirasat) records',false),
  ('mutations','create','Initiate mutation / succession cases',false),
  ('mutations','update','Update mutation heirs and advance workflow to apply share transfer',true),
  ('legal','read','View litigation register, stay orders and court hearings',false),
  ('legal','create','Register legal cases and court proceedings',false),
  ('legal','update','Update litigation status, stay orders and record hearings',false),
  ('budgets','read','View fiscal year project budgets and utilisation',false),
  ('budgets','create','Create fiscal year project budgets',false),
  ('budgets','update','Amend fiscal year project budgets',true),
  ('grievances','read','View community grievances and IIR investigations',false),
  ('grievances','create','Register community grievances',false),
  ('grievances','update','Investigate, escalate and resolve grievances',false),
  ('encroachments','read','View ROW and parcel encroachment cases',false),
  ('encroachments','create','Report ROW or parcel encroachments',false),
  ('encroachments','update','Update corrective actions and resolve encroachments',false),
  ('documents','read','View document repository and checksum registry',false),
  ('documents','create','Register and upload documents',false),
  ('documents','update','Update document metadata or soft-delete records',false),
  ('import','read','View bulk import batches, staging rows and validation errors',false),
  ('import','create','Stage bulk import batches',false),
  ('import','update','Validate and promote bulk import batches',true),
  ('inbox','read','View workflow approval queue and notifications',false),
  ('settings','read','View system configuration and workflow approval matrix',false),
  ('settings','update','Modify system configuration settings',true)
ON CONFLICT (resource, action) DO NOTHING;

CREATE FUNCTION pg_temp.grant_perm(p_role text, p_perm text, p_scope text DEFAULT 'province') RETURNS void
  LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO iam.role_permission(role_id, permission_id, scope_level)
  SELECT r.id, p.id, p_scope FROM iam.role r, iam.permission p
  WHERE r.code = p_role AND p.resource||':'||p.action = p_perm
  ON CONFLICT DO NOTHING;
END $f$;

DO $$
DECLARE
  new_reads text[] := ARRAY[
    'acquisitions:read','mutations:read','legal:read','budgets:read',
    'grievances:read','encroachments:read','documents:read','import:read',
    'inbox:read','settings:read'
  ];
  ops_writes text[] := ARRAY[
    'projects:update','landowners:update','cases:update','rows:update',
    'dbpfc:create','dbpfc:update','acquisitions:create','acquisitions:update',
    'mutations:create','mutations:update','legal:create','legal:update',
    'grievances:create','grievances:update','encroachments:create','encroachments:update',
    'documents:create','documents:update','import:create','import:update',
    'requests:create'
  ];
  p text;
BEGIN
  -- All roles get read access to operational & compliance registers in their scope
  FOREACH p IN ARRAY new_reads LOOP
    PERFORM pg_temp.grant_perm('system-administrator', p, 'global');
    PERFORM pg_temp.grant_perm('land-manager', p);
    PERFORM pg_temp.grant_perm('finance-approver', p);
    PERFORM pg_temp.grant_perm('case-approver', p);
    PERFORM pg_temp.grant_perm('data-entry', p);
    PERFORM pg_temp.grant_perm('viewer', p);
    PERFORM pg_temp.grant_perm('security-auditor', p, 'global');
  END LOOP;

  -- Operational writes for system-administrator, land-manager, case-approver, data-entry
  FOREACH p IN ARRAY ops_writes LOOP
    PERFORM pg_temp.grant_perm('system-administrator', p, 'global');
    PERFORM pg_temp.grant_perm('land-manager', p);
    PERFORM pg_temp.grant_perm('case-approver', p);
    PERFORM pg_temp.grant_perm('data-entry', p);
  END LOOP;

  -- Budgets & payment management permissions
  PERFORM pg_temp.grant_perm('system-administrator', 'budgets:create', 'global');
  PERFORM pg_temp.grant_perm('system-administrator', 'budgets:update', 'global');
  PERFORM pg_temp.grant_perm('system-administrator', 'settings:update', 'global');
  PERFORM pg_temp.grant_perm('system-administrator', 'leases:update', 'global');

  PERFORM pg_temp.grant_perm('land-manager', 'budgets:create');
  PERFORM pg_temp.grant_perm('land-manager', 'budgets:update');
  PERFORM pg_temp.grant_perm('land-manager', 'payments:update');

  PERFORM pg_temp.grant_perm('finance-approver', 'budgets:create');
  PERFORM pg_temp.grant_perm('finance-approver', 'budgets:update');
  PERFORM pg_temp.grant_perm('finance-approver', 'payments:update');
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lms, api, audit, util, iam FROM PUBLIC;
