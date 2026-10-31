-- =====================================================================
-- 0038  Case settlement as a set, not a function call per case
-- =====================================================================
-- api.v_case_status and api.v_outstanding_liability joined
-- LATERAL api.case_settlement(c.id) for every case. The function pins its
-- search_path (a 0030 control, kept), so PostgreSQL cannot inline it and runs
-- three row-secured scans per case: on the volume fixture (30,000 cases)
-- listing liabilities took ~12 s and counting cases ~4.5 s.
--
-- lms.case_settlement_totals computes the same two sums for all cases in one
-- grouped pass (security_invoker, so row-level security applies exactly as it
-- did inside the function). The views join it; a case with no allocations
-- gets 0, as the function returned. Columns, names and types are unchanged.
-- api.case_settlement() stays for callers that want one case.
SET ROLE lms_owner;

CREATE VIEW lms.case_settlement_totals WITH (security_invoker = true) AS
  SELECT al.case_id,
         coalesce(sum(al.amount) FILTER (WHERE pr.stage_code NOT IN ('Cancelled','Stopped')), 0)::numeric(18,2)::numeric AS allocated_amount,
         coalesce(sum(al.amount) FILTER (WHERE rel.payment_id IS NOT NULL), 0)::numeric(18,2)::numeric AS released_amount
    FROM lms.payment_allocation al
    JOIN lms.payment_request pr ON pr.id = al.payment_id
    LEFT JOIN lms.payment_release rel ON rel.payment_id = al.payment_id
   GROUP BY al.case_id;
REVOKE ALL ON lms.case_settlement_totals FROM PUBLIC;
GRANT SELECT ON lms.case_settlement_totals TO lms_readwrite, lms_readonly;

CREATE OR REPLACE VIEW api.v_case_status WITH (security_invoker = true) AS
 SELECT c.id AS case_id,
    c.code AS case_code,
    c.lease_no,
    c.province_code,
    p.code AS project_code,
    p.name AS project_name,
    c.land_use_code,
    c.case_date,
    c.effective_date,
    c.stage_code,
    st.seq AS stage_seq,
    c.approved_at,
    c.total_lease_area,
    c.total_lease_amount,
    c.total_crop_amount,
    c.total_tree_amount,
    c.total_misc_amount,
    c.total_amount,
    api.acre_ghunta((c.total_lease_area)::numeric) AS lease_area_acre_ghunta,
    o.owner_count,
    o.owner_codes,
    (CURRENT_DATE - COALESCE(t.last_acted, c.case_date)) AS days_at_stage,
    wa.assigned_group AS waiting_on_group,
    s.allocated_amount,
    s.released_amount,
    (((c.total_amount)::numeric - s.released_amount))::numeric(18,2) AS outstanding_amount
   FROM (((((((lms.compensation_case c
     JOIN lms.project p ON ((p.id = c.project_id)))
     JOIN lms.workflow_stage st ON (((st.workflow_code = 'cases'::text) AND (st.code = c.stage_code))))
     LEFT JOIN lms.case_settlement_totals s0 ON ((s0.case_id = c.id)))
     CROSS JOIN LATERAL ( SELECT COALESCE(s0.allocated_amount, (0)::numeric) AS allocated_amount,
            COALESCE(s0.released_amount, (0)::numeric) AS released_amount) s)
     LEFT JOIN LATERAL ( SELECT count(*) AS owner_count,
            string_agg((lo.code)::text, ', '::text ORDER BY lo.code) AS owner_codes
           FROM (lms.case_owner co
             JOIN lms.landowner lo ON ((lo.id = co.landowner_id)))
          WHERE (co.case_id = c.id)) o ON (true))
     LEFT JOIN LATERAL ( SELECT (max(wt.acted_at))::date AS last_acted
           FROM lms.workflow_transition wt
          WHERE ((wt.workflow_code = 'cases'::text) AND (wt.record_id = c.id))) t ON (true))
     LEFT JOIN lms.workflow_assignment wa ON (((wa.workflow_code = 'cases'::text) AND (wa.record_id = c.id) AND (wa.closed_at IS NULL))));

CREATE OR REPLACE VIEW api.v_outstanding_liability WITH (security_invoker = true) AS
 SELECT c.id AS case_id,
    c.code AS case_code,
    c.province_code,
    p.code AS project_code,
    p.name AS project_name,
    c.approved_at,
    c.total_amount AS approved_amount,
    s.allocated_amount,
    s.released_amount,
    (((c.total_amount)::numeric - s.released_amount))::numeric(18,2) AS outstanding_amount,
    (CURRENT_DATE - (c.approved_at)::date) AS days_since_approval,
        CASE
            WHEN (((c.total_amount)::numeric - s.released_amount) <= (0)::numeric) THEN 'settled'::text
            WHEN (s.released_amount = (0)::numeric) THEN 'unpaid'::text
            ELSE 'part paid'::text
        END AS settlement_status,
    o.payees
   FROM ((((lms.compensation_case c
     JOIN lms.project p ON ((p.id = c.project_id)))
     LEFT JOIN lms.case_settlement_totals s0 ON ((s0.case_id = c.id)))
     CROSS JOIN LATERAL ( SELECT COALESCE(s0.allocated_amount, (0)::numeric) AS allocated_amount,
            COALESCE(s0.released_amount, (0)::numeric) AS released_amount) s)
     LEFT JOIN LATERAL ( SELECT string_agg(DISTINCT lo.full_name, ', '::text) AS payees
           FROM (lms.case_owner co
             JOIN lms.landowner lo ON ((lo.id = co.landowner_id)))
          WHERE (co.case_id = c.id)) o ON (true))
  WHERE (c.stage_code = 'HO Approved'::text);

RESET ROLE;
