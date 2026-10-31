-- =====================================================================
-- Synthetic volume fixture for query-plan measurement
-- =====================================================================
-- ALL FICTIONAL, and generated rather than realistic in its details: the point
-- is the shape and the volume, not the content. Row counts are set to roughly
-- a decade of operation at the scale the client's documents describe — four
-- provinces, a few hundred projects, tens of thousands of parcels, and the
-- payment and audit history that accumulates behind them.
--
-- Never load this into lms_dev or anything else. db/tools/perf.py builds a
-- throwaway database for it.
--
-- The audit, version-snapshot and stamping triggers are disabled for the load
-- and the audit rows are generated in bulk instead. Keeping them on would make
-- the load take hours and would not change any plan being measured.
\set ON_ERROR_STOP on
\timing on

SET ROLE lms_owner;
SET lms.actor_id = '00000000-0000-0000-0000-000000000001';

-- Scale knobs. :scale multiplies everything; 1 is the default size.
\if :{?scale}
\else
  \set scale 1
\endif

ALTER TABLE lms.admin_unit            DISABLE TRIGGER USER;
ALTER TABLE lms.project               DISABLE TRIGGER USER;
ALTER TABLE lms.survey                DISABLE TRIGGER USER;
ALTER TABLE lms.landowner             DISABLE TRIGGER USER;
ALTER TABLE lms.survey_ownership_share DISABLE TRIGGER USER;
ALTER TABLE lms.compensation_case     DISABLE TRIGGER USER;
ALTER TABLE lms.case_owner            DISABLE TRIGGER USER;
ALTER TABLE lms.case_lease_line       DISABLE TRIGGER USER;
ALTER TABLE lms.case_crop_line        DISABLE TRIGGER USER;
ALTER TABLE lms.lease                 DISABLE TRIGGER USER;
ALTER TABLE lms.lease_survey          DISABLE TRIGGER USER;
ALTER TABLE lms.lease_lessor          DISABLE TRIGGER USER;
ALTER TABLE lms.payment_request       DISABLE TRIGGER USER;
ALTER TABLE lms.payment_release       DISABLE TRIGGER USER;
ALTER TABLE lms.payment_allocation    DISABLE TRIGGER USER;
ALTER TABLE lms.budget                DISABLE TRIGGER USER;
ALTER TABLE lms.grievance             DISABLE TRIGGER USER;
ALTER TABLE lms.encroachment          DISABLE TRIGGER USER;
ALTER TABLE lms.row_corridor          DISABLE TRIGGER USER;

-- ---------------------------------------------------------------------
-- Administrative hierarchy: 4 provinces, 40 districts, and the tiers below.
-- ---------------------------------------------------------------------
INSERT INTO lms.admin_unit (code, province_code, level, parent_id, name, created_by, updated_by)
-- row_number(), not g: g repeats for each province in the cross join and the
-- code has to be unique across all four.
SELECT 'PF-D' || lpad((row_number() OVER (ORDER BY p.display_order, g))::text, 5, '0'),
       p.code, 0, NULL,
       'District ' || g || ' (' || p.code || ')',
       '00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 10) g
CROSS JOIN lms.province p;

INSERT INTO lms.admin_unit (code, province_code, level, parent_id, name, created_by, updated_by)
SELECT 'PF-T' || lpad((row_number() OVER ())::text, 6, '0'), d.province_code, 1, d.id,
       'Tehsil ' || g || ' of ' || d.name,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM lms.admin_unit d, generate_series(1, 5) g
WHERE d.level = 0 AND d.code LIKE 'PF-%';

INSERT INTO lms.admin_unit (code, province_code, level, parent_id, name, created_by, updated_by)
SELECT 'PF-M' || lpad((row_number() OVER ())::text, 7, '0'), t.province_code, 2, t.id,
       'Mouza ' || g || ' of ' || t.name,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM lms.admin_unit t, generate_series(1, 6) g
WHERE t.level = 1 AND t.code LIKE 'PF-%';

-- ---------------------------------------------------------------------
-- Numbered helper tables.
--
-- Everything below picks a parent row by modular arithmetic on a row number.
-- The obvious alternative — a correlated "ORDER BY code OFFSET (g % n) LIMIT 1"
-- — re-scans the candidate set once per generated row, which turns a 60,000-row
-- insert into tens of millions of index walks. Numbering once and joining on
-- the number is the difference between minutes and hours.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE pf_dist AS
SELECT id, province_code, (row_number() OVER (ORDER BY code))::int AS rn,
       (count(*) OVER ())::int AS n
FROM lms.admin_unit WHERE level = 0 AND code LIKE 'PF-%';
CREATE INDEX ON pf_dist (rn);

CREATE TEMP TABLE pf_mouza AS
SELECT id, province_code, (row_number() OVER (ORDER BY code))::int AS rn,
       (count(*) OVER ())::int AS n
FROM lms.admin_unit WHERE level = 2 AND code LIKE 'PF-%';
CREATE INDEX ON pf_mouza (rn);

-- ---------------------------------------------------------------------
-- Projects: 400

-- ---------------------------------------------------------------------
INSERT INTO lms.project (code, name, type_code, block, province_code, district_id,
                         required_area, status, created_by, updated_by)
SELECT 'PF-P' || lpad(g::text, 5, '0'),
       'Perf project ' || g,
       (ARRAY['Well Location','Pipeline','Access Road','Camp / Base','Compressor Station'])[1 + g % 5],
       'Block ' || (1 + g % 25),
       d.province_code, d.id,
       (5 + g % 40)::numeric,
       CASE WHEN g % 11 = 0 THEN 'Completed' ELSE 'Active' END,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 400 * :scale) g
JOIN pf_dist d ON d.rn = 1 + (g % (SELECT n FROM pf_dist LIMIT 1));

INSERT INTO lms.budget (code, province_code, project_id, fiscal_year, approved_amount,
                        created_by, updated_by)
SELECT 'PF-B' || lpad((row_number() OVER ())::text, 7, '0'), p.province_code, p.id, y,
       (5000000 + (random() * 150000000))::numeric(18,2),
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM lms.project p, generate_series(2019, 2026) y
WHERE p.code LIKE 'PF-%';

-- ---------------------------------------------------------------------
-- Parcels: 60,000
-- ---------------------------------------------------------------------
INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, total_area,
                        land_class, status_code, lat, lng, created_by, updated_by)
SELECT 'PF-S' || lpad(g::text, 7, '0'), u.province_code, u.id,
       (1000 + g)::text,
       (1 + (random() * 80))::numeric(14,4),
       CASE WHEN g % 9 = 0 THEN 'Government' ELSE 'Private' END,
       (ARRAY['Proposed','Under Acquisition','Acquired','Leased','Released','Disputed'])[1 + g % 6],
       (24 + random() * 12)::numeric(9,6), (62 + random() * 12)::numeric(9,6),
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 60000 * :scale) g
JOIN pf_mouza u ON u.rn = 1 + (g % (SELECT n FROM pf_mouza LIMIT 1));

-- ---------------------------------------------------------------------
-- Landowners: 50,000, with names drawn from a small pool so that a name
-- search has realistic selectivity rather than matching one row every time.
-- ---------------------------------------------------------------------
INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, phone,
                           owner_type, status, tax_status, iban, created_by, updated_by)
SELECT 'PF-L' || lpad(g::text, 7, '0'),
       (ARRAY['SND','BAL','PNJ','KPK'])[1 + g % 4],
       (ARRAY['Muhammad','Ghulam','Allah','Abdul','Noor','Imran','Rasool','Sakina',
              'Zubaida','Hakim','Mukhtiar','Shahbaz','Niaz','Waqar','Benazir'])[1 + g % 15]
         || ' ' ||
       (ARRAY['Jarwar','Khoso','Mahar','Shaikh','Bugti','Lashari','Khattak','Baloch',
              'Chandio','Marri','Jamali','Raisani'])[1 + g % 12]
         || ' ' || g,
       'Father of ' || g,
       lpad((40000 + g % 20000)::text, 5, '0') || '-' ||
         lpad((g % 10000000)::text, 7, '0') || '-' || (g % 10)::text,
       '+92 3' || lpad((g % 100000000)::text, 8, '0'),
       (ARRAY['O','O','O','B','A'])[1 + g % 5],
       CASE WHEN g % 50 = 0 THEN 'Deceased' WHEN g % 97 = 0 THEN 'Inactive' ELSE 'Active' END,
       CASE WHEN g % 3 = 0 THEN 'Non-Filer' ELSE 'Filer' END,
       'PK' || lpad((10 + g % 90)::text, 2, '0') || 'HABB' ||
         lpad((g % 10000000000000000)::text, 16, '0'),
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 50000 * :scale) g;

-- Number the generated projects, parcels and landowners per province, so the
-- joins below can pick a parent by arithmetic instead of by scanning.
CREATE TEMP TABLE pf_proj AS
SELECT id, province_code, block,
       (row_number() OVER (PARTITION BY province_code ORDER BY code))::int AS rn,
       (count(*) OVER (PARTITION BY province_code))::int AS n
FROM lms.project WHERE code LIKE 'PF-%';
CREATE INDEX ON pf_proj (province_code, rn);

CREATE TEMP TABLE pf_lo AS
SELECT id, province_code,
       (row_number() OVER (PARTITION BY province_code ORDER BY code))::int AS rn,
       (count(*) OVER (PARTITION BY province_code))::int AS n
FROM lms.landowner WHERE code LIKE 'PF-%';
CREATE INDEX ON pf_lo (province_code, rn);

CREATE TEMP TABLE pf_surv AS
SELECT id, province_code, total_area, lat, lng,
       (row_number() OVER (PARTITION BY province_code ORDER BY code))::int AS rn,
       (count(*) OVER (PARTITION BY province_code))::int AS n
FROM lms.survey WHERE code LIKE 'PF-%';
CREATE INDEX ON pf_surv (province_code, rn);

-- Holdings: two per parcel on average, within the same province.
INSERT INTO lms.survey_ownership_share (survey_id, landowner_id, share_pct,
                                        revenue_doc_ref, created_by, updated_by)
SELECT s.id, l.id,
       CASE WHEN k = 1 THEN 60.0000 ELSE 40.0000 END,
       'Form VII-B / ' || s.rn,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM pf_surv s
JOIN generate_series(1, 2) k ON true
JOIN pf_lo l ON l.province_code = s.province_code
            AND l.rn = 1 + ((s.rn * 7 + k * 3001) % l.n)
ON CONFLICT (survey_id, landowner_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Compensation cases: 30,000 across eight years, most of them approved.
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS lms.pf_case_seq;
INSERT INTO lms.compensation_case
  (code, lease_no, province_code, project_id, land_use_code, business_unit, block_code,
   case_date, lease_rate, lease_term_months, effective_date,
   total_lease_area, total_lease_amount, total_crop_amount, total_tree_amount,
   total_misc_amount, stage_code, approved_at, cancelled_at, created_by, updated_by)
SELECT 'PF-CC' || lpad(g::text, 7, '0'), 'PF-LN' || lpad(g::text, 7, '0'),
       p.province_code, p.id,
       (ARRAY['Well Location','Access Road','Pipeline ROW','Camp','Other'])[1 + g % 5],
       p.block, p.block,
       (DATE '2019-01-01' + (g % 2900))::date,
       (80000 + g % 150000)::numeric(18,4), 12,
       (DATE '2019-01-15' + (g % 2900))::date,
       (1 + g % 30)::numeric(14,4),
       (100000 + (g % 97) * 15000)::numeric(18,2),
       (g % 53) * 9000::numeric(18,2),
       (g % 31) * 4000::numeric(18,2),
       (g % 17) * 25000::numeric(18,2),
       CASE WHEN g % 20 = 0 THEN 'Prepared'
            WHEN g % 20 = 1 THEN 'Checked'
            WHEN g % 20 = 2 THEN 'Reviewed'
            WHEN g % 20 = 3 THEN 'Verified'
            WHEN g % 20 = 4 THEN 'Field Approved'
            WHEN g % 20 = 5 THEN 'Cancelled'
            ELSE 'HO Approved' END,
       CASE WHEN g % 20 > 5 THEN (DATE '2019-02-01' + (g % 2900))::timestamptz END,
       -- The CHECK constraints tie each terminal stage to its timestamp, so
       -- both have to be set in the same statement.
       CASE WHEN g % 20 = 5 THEN (DATE '2019-02-01' + (g % 2900))::timestamptz END,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 30000 * :scale) g
JOIN LATERAL (SELECT id, province_code, block FROM pf_proj
              WHERE rn = 1 + (g % 100) AND province_code =
                    (ARRAY['SND','BAL','PNJ','KPK'])[1 + (g / 100) % 4] LIMIT 1) p ON true;

CREATE TEMP TABLE pf_case AS
SELECT id, province_code, project_id, case_date, stage_code, total_lease_area,
       (row_number() OVER (PARTITION BY province_code ORDER BY code))::int AS rn,
       (row_number() OVER (ORDER BY code))::int AS grn
FROM lms.compensation_case WHERE code LIKE 'PF-%';
CREATE INDEX ON pf_case (province_code, rn);
CREATE INDEX ON pf_case (grn);

INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct)
SELECT c.id, l.id, 'O', 100.0000
FROM pf_case c
JOIN pf_lo l ON l.province_code = c.province_code
            AND l.rn = 1 + ((c.rn * 13 + 977) % l.n)
ON CONFLICT (case_id, landowner_id) DO NOTHING;

INSERT INTO lms.case_lease_line (case_id, survey_id, lease_area, line_no)
SELECT c.id, s.id, least(c.total_lease_area, s.total_area), 1
FROM pf_case c
JOIN pf_surv s ON s.province_code = c.province_code
              AND s.rn = 1 + ((c.rn * 29 + 131) % s.n)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Leases: 20,000, with expiry dates spread across the past and the next
-- few years so the expiry-alert query has a realistic selectivity.
-- ---------------------------------------------------------------------
INSERT INTO lms.lease (code, province_code, project_id, kind, initial_area, start_date,
                       term_years, rate_per_acre, escalation_pct, stage_code,
                       created_by, updated_by)
SELECT 'PF-LSE' || lpad(g::text, 7, '0'), p.province_code, p.id,
       (ARRAY['Private Land','Government Land','ROW / Easement'])[1 + g % 3],
       (1 + g % 25)::numeric(14,4),
       (current_date - 2000 + (g % 2300))::date,
       (1 + g % 10)::smallint,
       (60000 + g % 120000)::numeric(18,4), 10.0000,
       CASE WHEN g % 13 = 0 THEN 'Draft' WHEN g % 13 = 1 THEN 'Under Review' ELSE 'Approved' END,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 20000 * :scale) g
JOIN LATERAL (SELECT id, province_code FROM pf_proj
              WHERE rn = 1 + (g % 100) AND province_code =
                    (ARRAY['SND','BAL','PNJ','KPK'])[1 + (g / 100) % 4] LIMIT 1) p ON true;

INSERT INTO lms.lease_lessor (lease_id, landowner_id)
SELECT l.id, lo.id
FROM (SELECT id, province_code,
             (row_number() OVER (PARTITION BY province_code ORDER BY code))::int AS rn
      FROM lms.lease WHERE code LIKE 'PF-%') l
JOIN pf_lo lo ON lo.province_code = l.province_code
             AND lo.rn = 1 + ((l.rn * 17 + 443) % lo.n)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Payments: 120,000 vouchers, 90,000 of them released.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE pf_approved AS
SELECT id, province_code, project_id, case_date,
       (row_number() OVER (ORDER BY id))::int AS arn
FROM lms.compensation_case WHERE code LIKE 'PF-%' AND stage_code = 'HO Approved';
CREATE INDEX ON pf_approved (arn);

INSERT INTO lms.payment_request
  (code, province_code, landowner_id, project_id, case_id, category_code, pay_type,
   land_class, period_from, period_to, gross_amount, wht_pct, payment_mode,
   stage_code, created_by, updated_by)
SELECT 'PF-VCH' || lpad(g::text, 8, '0'), c.province_code, co.landowner_id, c.project_id,
       c.id,
       (ARRAY['Lease Rent','Crop Compensation','Tree Compensation','ROW Compensation'])[1 + g % 4],
       (ARRAY['One-time','Yearly Lease','Advance Lease (multi-year)'])[1 + g % 3],
       'Private',
       (c.case_date + (g % 365))::date,
       (c.case_date + 365 + (g % 365))::date,
       (25000 + (g % 400) * 2500)::numeric(18,2),
       10.0000,
       (ARRAY['Cross Cheque','Pay Order','Direct Credit (IBFT)'])[1 + g % 3],
       CASE WHEN g % 10 = 0 THEN 'Requested'
            WHEN g % 10 = 1 THEN 'Verified'
            WHEN g % 10 = 2 THEN 'Cancelled'
            ELSE 'Released' END,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 120000 * :scale) g
JOIN pf_approved c ON c.arn = 1 + (g % (SELECT max(arn) FROM pf_approved))
JOIN lms.case_owner co ON co.case_id = c.id
ON CONFLICT DO NOTHING;

INSERT INTO lms.payment_release (payment_id, province_code, cheque_no, cheque_date,
                                 released_amount, released_by)
SELECT pr.id, pr.province_code,
       'PF-CHQ-' || lpad((row_number() OVER (ORDER BY pr.code))::text, 9, '0'),
       pr.period_from + 15, pr.net_amount,
       '00000000-0000-0000-0000-000000000001'
FROM lms.payment_request pr
WHERE pr.code LIKE 'PF-%' AND pr.stage_code = 'Released'
ON CONFLICT DO NOTHING;

INSERT INTO lms.payment_allocation (payment_id, case_id, amount)
SELECT pr.id, pr.case_id, pr.net_amount
FROM lms.payment_request pr
WHERE pr.code LIKE 'PF-%' AND pr.stage_code = 'Released' AND pr.case_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Grievances, encroachments, ROW corridors
-- ---------------------------------------------------------------------
INSERT INTO lms.grievance (code, province_code, grievance_type, complainant, project_id,
                           category_code, severity, received_date, due_date, description,
                           resolution, resolved_on, stage_code, created_by, updated_by)
SELECT 'PF-GRV' || lpad(g::text, 6, '0'), p.province_code, 'Landowner Complaint',
       'Complainant ' || g, p.id,
       (ARRAY['Compensation Amount','Payment Delay','Land Damage','Access Obstruction'])[1 + g % 4],
       (ARRAY['Low','Medium','High','Critical'])[1 + g % 4],
       (current_date - (g % 900))::date, (current_date - (g % 900) + 15)::date,
       'Generated grievance ' || g,
       CASE WHEN g % 4 <> 0 THEN 'Resolved in the field' END,
       CASE WHEN g % 4 <> 0 THEN (current_date - (g % 900) + 20)::date END,
       CASE WHEN g % 4 = 0 THEN 'In Progress' ELSE 'Resolved' END,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 8000 * :scale) g
JOIN LATERAL (SELECT id, province_code FROM pf_proj
              WHERE rn = 1 + (g % 100) AND province_code =
                    (ARRAY['SND','BAL','PNJ','KPK'])[1 + (g / 100) % 4] LIMIT 1) p ON true;

INSERT INTO lms.row_corridor (code, province_code, project_id, name, row_type, length_m,
                              width_m, agreement_date, tenure_years, annual_rent,
                              stage_code, created_by, updated_by)
SELECT 'PF-ROW' || lpad(g::text, 6, '0'), p.province_code, p.id,
       'KP ' || g || '+000', 'Pipeline ROW',
       (500 + g % 9000)::numeric(12,2), (6 + g % 15)::numeric(8,2),
       (current_date - (g % 2500))::date, (5 + g % 20)::smallint,
       (200000 + g % 2000000)::numeric(18,2), 'Approved',
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 4000 * :scale) g
JOIN LATERAL (SELECT id, province_code FROM pf_proj
              WHERE rn = 1 + (g % 100) AND province_code =
                    (ARRAY['SND','BAL','PNJ','KPK'])[1 + (g / 100) % 4] LIMIT 1) p ON true;

INSERT INTO lms.encroachment (code, province_code, category_code, project_id, survey_id,
                              lat, lng, detected_on, risk, description, stage_code,
                              created_by, updated_by)
SELECT 'PF-ENC' || lpad(g::text, 6, '0'), s.province_code,
       (ARRAY['Construction on ROW','Cultivation on ROW','Boundary Encroachment'])[1 + g % 3],
       p.id, s.id, s.lat, s.lng, (current_date - (g % 800))::date,
       (ARRAY['Low','Medium','High','Critical'])[1 + g % 4],
       'Generated incident ' || g,
       CASE WHEN g % 3 = 0 THEN 'Reported' ELSE 'Resolved' END,
       '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 5000 * :scale) g
JOIN LATERAL (SELECT id, province_code, lat, lng FROM pf_surv
              WHERE rn = 1 + (g % 1000) AND province_code =
                    (ARRAY['SND','BAL','PNJ','KPK'])[1 + (g / 1000) % 4] LIMIT 1) s ON true
JOIN LATERAL (SELECT id FROM pf_proj WHERE province_code = s.province_code
              ORDER BY rn LIMIT 1) p ON true;

-- ---------------------------------------------------------------------
-- Workflow transitions and audit events: the two tables that grow fastest and
-- that every "what happened to this record" query reads.
-- ---------------------------------------------------------------------
INSERT INTO lms.workflow_transition
  (workflow_code, record_id, record_code, province_code, from_stage, to_stage,
   action, acted_by, acted_at, note)
SELECT 'cases', c.id, c.code, c.province_code, st.prev, st.cur,
       CASE WHEN st.prev IS NULL THEN 'Created' ELSE 'Advanced' END,
       '00000000-0000-0000-0000-000000000001',
       c.case_date::timestamptz + (st.seq * interval '2 days'),
       'generated'
FROM lms.compensation_case c
JOIN LATERAL (VALUES (0, NULL, 'Prepared'), (1, 'Prepared','Checked'),
                     (2, 'Checked','Reviewed'), (3, 'Reviewed','Verified'),
                     (4, 'Verified','Field Approved'), (5, 'Field Approved','HO Approved'))
  AS st(seq, prev, cur) ON true
WHERE c.code LIKE 'PF-%' AND c.stage_code = 'HO Approved';

INSERT INTO audit.audit_event
  (occurred_at, actor_id, actor_username, actor_role, entity, record_id, record_code,
   province_code, action, old_data, new_data, changed_fields)
SELECT t.acted_at, t.acted_by, 'system', 'Admin', 'compensation_case', t.record_id,
       t.record_code, t.province_code, 'TRANSITION',
       jsonb_build_object('stage_code', t.from_stage),
       jsonb_build_object('stage_code', t.to_stage),
       ARRAY['stage_code']
FROM lms.workflow_transition t
WHERE t.record_code LIKE 'PF-%';

INSERT INTO audit.audit_event
  (occurred_at, actor_id, actor_username, actor_role, entity, record_id, record_code,
   province_code, action, new_data, changed_fields)
SELECT pr.created_at, '00000000-0000-0000-0000-000000000001', 'system', 'Admin',
       'payment_request', pr.id, pr.code, pr.province_code, 'INSERT',
       jsonb_build_object('gross_amount', pr.gross_amount, 'stage_code', pr.stage_code),
       ARRAY['gross_amount','stage_code']
FROM lms.payment_request pr WHERE pr.code LIKE 'PF-%';

INSERT INTO audit.audit_event
  (occurred_at, actor_id, actor_username, actor_role, entity, record_id, record_code,
   province_code, action, new_data, changed_fields)
SELECT l.created_at, '00000000-0000-0000-0000-000000000001', 'system', 'Admin',
       'landowner', l.id, l.code, l.province_code, 'INSERT',
       jsonb_build_object('full_name', l.full_name), ARRAY['full_name']
FROM lms.landowner l WHERE l.code LIKE 'PF-%';

-- Open approval queues, for the bottleneck query.
INSERT INTO lms.workflow_assignment (workflow_code, record_id, stage_code, assigned_group,
                                     assigned_at, due_at)
SELECT 'cases', c.id, c.stage_code,
       (ARRAY['Negotiation Group','Legal Advisor','Sr. Administrator LMS (Field)',
              'DM / Team Lead (Field)','Manager Land (HO)'])[1 + (abs(hashtext(c.code::text)) % 5)],
       c.case_date::timestamptz, c.case_date::timestamptz + interval '7 days'
FROM lms.compensation_case c
WHERE c.code LIKE 'PF-%' AND c.stage_code NOT IN ('HO Approved','Cancelled')
ON CONFLICT DO NOTHING;

ALTER TABLE lms.admin_unit            ENABLE TRIGGER USER;
ALTER TABLE lms.project               ENABLE TRIGGER USER;
ALTER TABLE lms.survey                ENABLE TRIGGER USER;
ALTER TABLE lms.landowner             ENABLE TRIGGER USER;
ALTER TABLE lms.survey_ownership_share ENABLE TRIGGER USER;
ALTER TABLE lms.compensation_case     ENABLE TRIGGER USER;
ALTER TABLE lms.case_owner            ENABLE TRIGGER USER;
ALTER TABLE lms.case_lease_line       ENABLE TRIGGER USER;
ALTER TABLE lms.case_crop_line        ENABLE TRIGGER USER;
ALTER TABLE lms.lease                 ENABLE TRIGGER USER;
ALTER TABLE lms.lease_survey          ENABLE TRIGGER USER;
ALTER TABLE lms.lease_lessor          ENABLE TRIGGER USER;
ALTER TABLE lms.payment_request       ENABLE TRIGGER USER;
ALTER TABLE lms.payment_release       ENABLE TRIGGER USER;
ALTER TABLE lms.payment_allocation    ENABLE TRIGGER USER;
ALTER TABLE lms.budget                ENABLE TRIGGER USER;
ALTER TABLE lms.grievance             ENABLE TRIGGER USER;
ALTER TABLE lms.encroachment          ENABLE TRIGGER USER;
ALTER TABLE lms.row_corridor          ENABLE TRIGGER USER;

-- Plans are only meaningful against current statistics.
ANALYZE;
