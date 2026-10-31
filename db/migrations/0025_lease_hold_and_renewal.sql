-- 0025_lease_hold_and_renewal.sql
-- Implements Slide 15 reason-based hold & release controls on Surface Leases
-- and integrates with api.v_lease_register

SET search_path = lms, public;

ALTER TABLE lms.lease ADD COLUMN IF NOT EXISTS is_on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE lms.lease ADD COLUMN IF NOT EXISTS hold_reason text;
ALTER TABLE lms.lease ADD COLUMN IF NOT EXISTS hold_placed_at timestamptz;
ALTER TABLE lms.lease ADD COLUMN IF NOT EXISTS hold_placed_by uuid REFERENCES lms.app_user(id);
ALTER TABLE lms.lease ADD COLUMN IF NOT EXISTS hold_lifted_at timestamptz;
ALTER TABLE lms.lease ADD COLUMN IF NOT EXISTS hold_lifted_by uuid REFERENCES lms.app_user(id);
ALTER TABLE lms.lease ADD COLUMN IF NOT EXISTS hold_lift_reason text;

-- Update api.v_lease_register to expose hold status & reasons (appended columns to maintain view binary compatibility)
CREATE OR REPLACE VIEW api.v_lease_register WITH (security_invoker = true) AS
SELECT l.id AS lease_id, l.code AS lease_code, l.province_code,
       p.code AS project_code, p.name AS project_name,
       cc.code AS case_code,
       l.kind, l.registration_no,
       l.initial_area, coalesce(l.subsequent_area, l.initial_area) AS current_area,
       l.start_date, l.term_years, l.end_date, l.terminated_on,
       l.rate_per_acre, l.escalation_pct, l.auto_extend, l.stage_code,
       round(l.rate_per_acre * coalesce(l.subsequent_area, l.initial_area), 2) AS annual_rent,
       (l.end_date - current_date)                                  AS days_to_expiry,
       CASE WHEN l.terminated_on IS NOT NULL             THEN 'Terminated'
            WHEN l.is_on_hold = true                      THEN 'On Hold'
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
         WHERE lsv.lease_id = l.id)                                 AS parcels,
       l.is_on_hold,
       l.hold_reason,
       l.hold_placed_at
FROM lms.lease l
JOIN lms.project p ON p.id = l.project_id
LEFT JOIN lms.compensation_case cc ON cc.id = l.case_id;

GRANT SELECT ON api.v_lease_register TO lms_readonly, lms_readwrite, lms_app;
