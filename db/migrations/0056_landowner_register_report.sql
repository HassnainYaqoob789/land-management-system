-- =====================================================================
-- 0056  Landowner register report (read-only, province-wise)
-- =====================================================================
-- Asked for on 2026-10-31: the system administrator needs one screen with
-- every landowner, their parcels (khasra), province, revenue location, share,
-- area in the province's unit, with filters and export.
--
-- 0047 deliberately keeps the administrator out of the business registers
-- (no landowners:read, no surveys:read, no edits). This adds ONE narrow
-- permission instead of those: landowner_report:read, which opens only the
-- read-only "Landowner register" report (dataset `landowner_register` in
-- src/lib/reporting/catalog.ts). It gives no access to the Landowners or
-- Survey screens, no create/update, and no pii:read: without pii:read the
-- CNIC is masked by the report engine.
--
-- Granted to the roles that oversee all provinces: system-administrator,
-- land-manager, security-auditor, finance-approver. Field roles already read
-- the same data in their own provinces through landowners:read and could be
-- granted it later; row-level security limits every reader to their provinces
-- either way (api.rpt_ownership is security_invoker).
--
-- Also adds two columns to api.rpt_ownership for the report's filters: the
-- owner's FBR tax status and whether a payment hold is active on the owner.

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

INSERT INTO iam.permission (resource, action, description, is_sensitive)
VALUES ('landowner_report', 'read',
        'Read the landowner register report (owners, parcels, shares, areas; CNIC masked without pii:read). Read-only.', false)
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
SELECT r.id, p.id, CASE WHEN r.code = 'land-manager' THEN 'head_office' ELSE 'global' END
  FROM iam.role r
  JOIN iam.permission p ON p.resource = 'landowner_report' AND p.action = 'read'
 WHERE r.code IN ('system-administrator', 'land-manager', 'security-auditor', 'finance-approver')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- api.rpt_ownership, unchanged, plus tax_status and owner_on_hold at the end.
CREATE OR REPLACE VIEW api.rpt_ownership WITH (security_invoker = true) AS
 WITH tot AS (
         SELECT o.survey_id, sum(o.share_pct::numeric) AS share_total
           FROM lms.survey_ownership_share o
          GROUP BY o.survey_id
        )
 SELECT sh.id AS share_id,
    sh.survey_id,
    sh.landowner_id,
    lo.code AS owner_code,
    lo.full_name AS owner_name,
    lo.father_name,
    lo.cnic::text AS cnic,
    lo.owner_type::text AS owner_type,
    lo.status AS owner_status,
    s.province_code,
    au.district,
    au.tehsil,
    au.village,
    s.code AS parcel_code,
    s.survey_no,
    s.land_class,
    s.status_code AS parcel_status,
    sh.share_pct::numeric AS share_pct,
    s.total_area::numeric AS parcel_area_acres,
    s.recorded_area::numeric AS parcel_area_recorded,
    s.recorded_unit,
    s.total_area::numeric * sh.share_pct::numeric / 100::numeric AS owned_area_acres,
    s.recorded_area * sh.share_pct::numeric / 100::numeric AS owned_area_recorded,
    sh.effective_from,
    sh.revenue_doc_ref,
    abs(COALESCE(tot.share_total, 0::numeric) - 100::numeric) > 0.0001 AS flag_shares_not_100,
    s.recorded_factor_confirmed IS FALSE AS flag_recorded_provisional,
    lo.tax_status,
    EXISTS (SELECT 1 FROM lms.payment_hold h
             WHERE h.scope = 'landowner' AND h.landowner_id = lo.id AND h.lifted_at IS NULL) AS owner_on_hold
   FROM lms.survey_ownership_share sh
     JOIN lms.survey s ON s.id = sh.survey_id
     JOIN lms.landowner lo ON lo.id = sh.landowner_id
     LEFT JOIN lms.admin_unit_lineage au ON au.unit_id = s.admin_unit_id
     LEFT JOIN tot ON tot.survey_id = sh.survey_id;

RESET ROLE;
