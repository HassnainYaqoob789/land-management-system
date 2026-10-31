-- Migration 0026: Executive Decision Intelligence, Measurement Standardization & GIS Mapping
-- Schema additions for LMS Enterprise Decision Intelligence & GIS

-- 1. Ensure all authoritative measurement units from Slide 5 exist in lms.measurement_unit
INSERT INTO lms.measurement_unit (code, name, is_area, display_order)
VALUES 
  ('Murabba', 'Murabba (25 Acres)', true, 1),
  ('Acre', 'Acre / Killa', true, 2),
  ('Jireb', 'Jireb / Bega (0.5 Acre)', true, 3),
  ('Rod', 'Rod (0.25 Acre)', true, 4),
  ('Kanal', 'Kanal (1/8 Acre)', true, 5),
  ('Ghunta', 'Ghunta / Wiswa (1/40 Acre)', true, 6),
  ('Marla', 'Pole / Marla (1/160 Acre)', true, 7),
  ('Square Yard', 'Square Yard', true, 8),
  ('Square Feet', 'Square Feet', true, 9),
  ('Square Meter', 'Square Metre (SI Base)', true, 10),
  ('Hectare', 'Hectare (10,000 m²)', true, 11)
ON CONFLICT (code) DO UPDATE 
SET name = EXCLUDED.name,
    display_order = EXCLUDED.display_order;

-- Update canonical sqm_per_unit in lms.unit_conversion to match Slide 5 exactly:
DELETE FROM lms.unit_conversion WHERE source_ref = 'slide5_authoritative';

INSERT INTO lms.unit_conversion (unit_code, sqm_per_unit, valid_from, is_confirmed, source_ref, note)
VALUES
  ('Murabba', 101171.4105600000, '1900-01-01', true, 'slide5_authoritative', '1 Murabba = 25 Acres = 1,089,000 sq ft'),
  ('Acre', 4046.8564224000, '1900-01-01', true, 'slide5_authoritative', '1 Acre = 43,560 sq ft'),
  ('Jireb', 2023.4282112000, '1900-01-01', true, 'slide5_authoritative', '1 Jireb = 0.5 Acre = 21,780 sq ft'),
  ('Rod', 1011.7141056000, '1900-01-01', true, 'slide5_authoritative', '1 Rod = 0.25 Acre = 10,890 sq ft'),
  ('Kanal', 505.8570528000, '1900-01-01', true, 'slide5_authoritative', '1 Kanal = 1/8 Acre = 5,445 sq ft'),
  ('Ghunta', 101.1714105600, '1900-01-01', true, 'slide5_authoritative', '1 Ghunta = 1/40 Acre = 1,089 sq ft (Sindh)'),
  ('Marla', 25.2928526400, '1900-01-01', true, 'slide5_authoritative', '1 Marla = 1/160 Acre = 272.25 sq ft (Punjab / KP)'),
  ('Square Yard', 0.8361273600, '1900-01-01', true, 'slide5_authoritative', '1 Sq Yard = 9 sq ft'),
  ('Square Feet', 0.0929030400, '1900-01-01', true, 'slide5_authoritative', '1 Sq Foot = 0.09290304 m²'),
  ('Square Meter', 1.0000000000, '1900-01-01', true, 'slide5_authoritative', 'SI canonical base area unit'),
  ('Hectare', 10000.0000000000, '1900-01-01', true, 'slide5_authoritative', '1 Hectare = 10,000 m²')
ON CONFLICT DO NOTHING;

-- 2. Deterministic SQL Area Conversion Function
CREATE OR REPLACE FUNCTION lms.convert_area(
  p_value numeric,
  p_from_unit text,
  p_to_unit text,
  p_province text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_from_sqm numeric;
  v_to_sqm numeric;
  v_result numeric;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- If units are identical, return unchanged value
  IF lower(trim(p_from_unit)) = lower(trim(p_to_unit)) THEN
    RETURN p_value;
  END IF;

  -- Canonical conversion factors in m² per unit
  v_from_sqm := CASE lower(trim(p_from_unit))
    WHEN 'acre' THEN 4046.8564224000
    WHEN 'killa' THEN 4046.8564224000
    WHEN 'murabba' THEN 101171.4105600000
    WHEN 'jireb' THEN 2023.4282112000
    WHEN 'bega' THEN 2023.4282112000
    WHEN 'rod' THEN 1011.7141056000
    WHEN 'kanal' THEN 505.8570528000
    WHEN 'ghunta' THEN 101.1714105600
    WHEN 'wiswa' THEN 101.1714105600
    WHEN 'marla' THEN 25.2928526400
    WHEN 'pole' THEN 25.2928526400
    WHEN 'square yard' THEN 0.8361273600
    WHEN 'sq yard' THEN 0.8361273600
    WHEN 'square feet' THEN 0.0929030400
    WHEN 'sq feet' THEN 0.0929030400
    WHEN 'sqft' THEN 0.0929030400
    WHEN 'square meter' THEN 1.0000000000
    WHEN 'sqm' THEN 1.0000000000
    WHEN 'm²' THEN 1.0000000000
    WHEN 'hectare' THEN 10000.0000000000
    WHEN 'ha' THEN 10000.0000000000
    ELSE NULL
  END;

  v_to_sqm := CASE lower(trim(p_to_unit))
    WHEN 'acre' THEN 4046.8564224000
    WHEN 'killa' THEN 4046.8564224000
    WHEN 'murabba' THEN 101171.4105600000
    WHEN 'jireb' THEN 2023.4282112000
    WHEN 'bega' THEN 2023.4282112000
    WHEN 'rod' THEN 1011.7141056000
    WHEN 'kanal' THEN 505.8570528000
    WHEN 'ghunta' THEN 101.1714105600
    WHEN 'wiswa' THEN 101.1714105600
    WHEN 'marla' THEN 25.2928526400
    WHEN 'pole' THEN 25.2928526400
    WHEN 'square yard' THEN 0.8361273600
    WHEN 'sq yard' THEN 0.8361273600
    WHEN 'square feet' THEN 0.0929030400
    WHEN 'sq feet' THEN 0.0929030400
    WHEN 'sqft' THEN 0.0929030400
    WHEN 'square meter' THEN 1.0000000000
    WHEN 'sqm' THEN 1.0000000000
    WHEN 'm²' THEN 1.0000000000
    WHEN 'hectare' THEN 10000.0000000000
    WHEN 'ha' THEN 10000.0000000000
    ELSE NULL
  END;

  IF v_from_sqm IS NULL THEN
    RAISE EXCEPTION 'Unsupported source land measurement unit: %', p_from_unit;
  END IF;
  IF v_to_sqm IS NULL THEN
    RAISE EXCEPTION 'Unsupported target land measurement unit: %', p_to_unit;
  END IF;

  v_result := (p_value * v_from_sqm) / v_to_sqm;
  RETURN round(v_result, 4);
END;
$$;

-- 3. Tables for GIS KML/KMZ Uploads, Spatial Features & Merged Datasets
CREATE TABLE IF NOT EXISTS lms.project_kml_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES lms.project(id) ON DELETE CASCADE,
  filename text NOT NULL,
  file_size integer NOT NULL,
  layer_name text NOT NULL,
  feature_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Merged', 'Archived', 'Failed')),
  error_details text,
  metadata jsonb DEFAULT '{}'::jsonb,
  imported_by uuid REFERENCES lms.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lms.project_spatial_feature (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid REFERENCES lms.project_kml_import(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES lms.project(id) ON DELETE CASCADE,
  survey_id uuid REFERENCES lms.survey(id) ON DELETE SET NULL,
  feature_name text NOT NULL,
  geometry_type text NOT NULL CHECK (geometry_type IN ('Point', 'LineString', 'Polygon', 'MultiPolygon', 'GeometryCollection')),
  coordinates jsonb NOT NULL,
  area_sqm numeric(18,4),
  area_acres numeric(18,4),
  is_merged boolean NOT NULL DEFAULT false,
  source_file text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lms.project_gis_merge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES lms.project(id) ON DELETE CASCADE,
  merge_name text NOT NULL,
  feature_count integer NOT NULL DEFAULT 0,
  total_area_sqm numeric(18,4) NOT NULL DEFAULT 0,
  total_area_acres numeric(18,4) NOT NULL DEFAULT 0,
  source_import_ids uuid[] NOT NULL,
  merged_kml_xml text,
  created_by uuid REFERENCES lms.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexing for Spatial Searches
CREATE INDEX IF NOT EXISTS idx_spatial_feat_project ON lms.project_spatial_feature(project_id);
CREATE INDEX IF NOT EXISTS idx_spatial_feat_survey ON lms.project_spatial_feature(survey_id);
CREATE INDEX IF NOT EXISTS idx_spatial_feat_type ON lms.project_spatial_feature(geometry_type);
CREATE INDEX IF NOT EXISTS idx_kml_import_proj ON lms.project_kml_import(project_id);

-- 4. Analytical Views for Executive Dashboards & Reporting

-- View: Executive KPIs (C-Level Dashboard)
CREATE OR REPLACE VIEW api.v_executive_kpis AS
WITH proj_stats AS (
  SELECT 
    count(DISTINCT id) as total_projects,
    count(DISTINCT CASE WHEN status = 'Active' THEN id END) as active_projects
  FROM lms.project
),
parcel_stats AS (
  SELECT 
    count(DISTINCT id) as total_parcels,
    COALESCE(sum(total_area), 0) as total_acres,
    count(DISTINCT CASE WHEN land_class = 'Government' THEN id END) as gov_parcels,
    COALESCE(sum(CASE WHEN land_class = 'Government' THEN total_area ELSE 0 END), 0) as gov_acres,
    count(DISTINCT CASE WHEN status_code = 'Acquired' THEN id END) as acquired_parcels,
    COALESCE(sum(CASE WHEN status_code = 'Acquired' THEN total_area ELSE 0 END), 0) as acquired_acres,
    count(DISTINCT CASE WHEN status_code = 'Leased' THEN id END) as leased_parcels,
    COALESCE(sum(CASE WHEN status_code = 'Leased' THEN total_area ELSE 0 END), 0) as leased_acres
  FROM lms.survey
),
owner_stats AS (
  SELECT 
    count(DISTINCT id) as total_landowners,
    count(DISTINCT CASE WHEN cnic IS NOT NULL AND cnic != '' THEN id END) as cnic_verified_owners
  FROM lms.landowner
),
comp_stats AS (
  SELECT 
    COALESCE(sum(total_amount), 0) as total_approved_compensation,
    count(DISTINCT id) as total_cases,
    count(DISTINCT CASE WHEN stage_code = 'HO Approved' THEN id END) as approved_cases,
    count(DISTINCT CASE WHEN stage_code NOT IN ('HO Approved', 'Cancelled') THEN id END) as pending_cases
  FROM lms.compensation_case
),
pay_stats AS (
  SELECT 
    COALESCE(sum(CASE WHEN stage_code = 'Released' THEN net_amount ELSE 0 END), 0) as total_compensation_paid,
    COALESCE(sum(CASE WHEN stage_code IN ('Requested', 'Verified', 'Approved') THEN net_amount ELSE 0 END), 0) as pending_payments,
    count(DISTINCT CASE WHEN stage_code = 'Released' THEN id END) as paid_cheques_count
  FROM lms.payment_request
),
lease_stats AS (
  SELECT 
    count(DISTINCT id) as total_leases,
    count(DISTINCT CASE WHEN end_date < CURRENT_DATE THEN id END) as expired_leases,
    count(DISTINCT CASE WHEN end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + interval '90 days') THEN id END) as expiring_90d_leases,
    count(DISTINCT CASE WHEN is_on_hold = true THEN id END) as hold_leases
  FROM lms.lease
),
risk_stats AS (
  SELECT 
    count(DISTINCT id) as total_grievances,
    count(DISTINCT CASE WHEN stage_code NOT IN ('Resolved', 'Closed') THEN id END) as open_grievances
  FROM lms.grievance
),
stay_stats AS (
  SELECT count(DISTINCT id) as active_stay_orders FROM lms.legal_case WHERE stay_order = true
),
gis_stats AS (
  SELECT count(DISTINCT id) as mapped_features FROM lms.project_spatial_feature
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
  GREATEST(0, comp_stats.total_approved_compensation - pay_stats.total_compensation_paid) as outstanding_liability,
  lease_stats.total_leases,
  lease_stats.expired_leases,
  lease_stats.expiring_90d_leases,
  lease_stats.hold_leases,
  risk_stats.open_grievances,
  stay_stats.active_stay_orders,
  gis_stats.mapped_features
FROM proj_stats, parcel_stats, owner_stats, comp_stats, pay_stats, lease_stats, risk_stats, stay_stats, gis_stats;

-- View: Project Portfolio (Director Dashboard)
CREATE OR REPLACE VIEW api.v_project_portfolio AS
SELECT 
  p.id as project_id,
  p.code as project_code,
  p.name as project_name,
  p.province_code,
  p.status as project_status,
  p.created_at as project_created_at,
  COALESCE(count(DISTINCT ps.survey_id), 0) as parcel_count,
  COALESCE(sum(s.total_area), 0) as total_area_acres,
  COALESCE(sum(CASE WHEN s.land_class = 'Government' THEN s.total_area ELSE 0 END), 0) as gov_area_acres,
  COALESCE(sum(CASE WHEN s.status_code = 'Acquired' THEN s.total_area ELSE 0 END), 0) as acquired_area_acres,
  COALESCE(sum(CASE WHEN s.status_code = 'Leased' THEN s.total_area ELSE 0 END), 0) as leased_area_acres,
  COALESCE(count(DISTINCT o.landowner_id), 0) as landowner_count,
  COALESCE(count(DISTINCT c.id), 0) as case_count,
  COALESCE(sum(CASE WHEN c.stage_code = 'HO Approved' THEN c.total_amount ELSE 0 END), 0) as approved_compensation,
  COALESCE(sum(CASE WHEN pay.stage_code = 'Released' THEN pay.net_amount ELSE 0 END), 0) as paid_compensation,
  GREATEST(0, 
    COALESCE(sum(CASE WHEN c.stage_code = 'HO Approved' THEN c.total_amount ELSE 0 END), 0) - 
    COALESCE(sum(CASE WHEN pay.stage_code = 'Released' THEN pay.net_amount ELSE 0 END), 0)
  ) as outstanding_liability,
  COALESCE(count(DISTINCT l.id), 0) as lease_count,
  COALESCE(count(DISTINCT CASE WHEN l.end_date < CURRENT_DATE THEN l.id END), 0) as expired_lease_count,
  COALESCE(count(DISTINCT CASE WHEN l.end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + interval '90 days') THEN l.id END), 0) as expiring_lease_count,
  COALESCE(count(DISTINCT feat.id), 0) as gis_feature_count
FROM lms.project p
LEFT JOIN lms.project_survey ps ON ps.project_id = p.id
LEFT JOIN lms.survey s ON s.id = ps.survey_id
LEFT JOIN lms.survey_ownership_share o ON o.survey_id = s.id
LEFT JOIN lms.compensation_case c ON c.project_id = p.id
LEFT JOIN lms.payment_request pay ON pay.project_id = p.id
LEFT JOIN lms.lease l ON l.project_id = p.id
LEFT JOIN lms.project_spatial_feature feat ON feat.project_id = p.id
GROUP BY p.id, p.code, p.name, p.province_code, p.status, p.created_at;

-- View: Financial Payment Aging & Liabilities
CREATE OR REPLACE VIEW api.v_finance_aging AS
SELECT 
  pr.id as payment_id,
  pr.code as payment_code,
  pr.province_code,
  pr.project_id,
  p.name as project_name,
  pr.landowner_id,
  lo.full_name as landowner_name,
  lo.cnic as landowner_cnic,
  pr.case_id,
  c.code as case_code,
  pr.category_code as payment_category,
  pr.gross_amount,
  pr.wht_amount,
  pr.net_amount,
  pr.stage_code as payment_status,
  CASE WHEN ph.id IS NOT NULL THEN true ELSE false END as is_on_hold,
  ph.reason as hold_reason,
  pr.created_at as request_date,
  CURRENT_DATE - pr.created_at::date as days_pending,
  CASE 
    WHEN (CURRENT_DATE - pr.created_at::date) <= 30 THEN '0-30 Days'
    WHEN (CURRENT_DATE - pr.created_at::date) <= 60 THEN '31-60 Days'
    WHEN (CURRENT_DATE - pr.created_at::date) <= 90 THEN '61-90 Days'
    ELSE 'Over 90 Days'
  END as aging_bracket
FROM lms.payment_request pr
LEFT JOIN lms.project p ON p.id = pr.project_id
LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
LEFT JOIN lms.compensation_case c ON c.id = pr.case_id
LEFT JOIN lms.payment_hold ph ON ph.payment_id = pr.id AND ph.lifted_at IS NULL;

-- View: Data Quality & Discrepancies Audit
CREATE OR REPLACE VIEW api.v_data_quality_audit AS
SELECT 
  'Share Discrepancy' as issue_type,
  'Survey ' || s.code || ' shares total ' || COALESCE(sum(o.share_pct), 0) || '% (expected 100%)' as description,
  s.province_code,
  s.id::text as record_id,
  'survey' as entity_name,
  s.created_at
FROM lms.survey s
LEFT JOIN lms.survey_ownership_share o ON o.survey_id = s.id
GROUP BY s.id, s.code, s.province_code, s.created_at
HAVING ABS(COALESCE(sum(o.share_pct), 0) - 100.0) > 0.01

UNION ALL

SELECT 
  'Missing CNIC' as issue_type,
  'Landowner ' || lo.full_name || ' (' || lo.code || ') has no verified CNIC' as description,
  lo.province_code,
  lo.id::text as record_id,
  'landowner' as entity_name,
  lo.created_at
FROM lms.landowner lo
WHERE lo.cnic IS NULL OR lo.cnic = ''

UNION ALL

SELECT 
  'Lease Expired Unrenewed' as issue_type,
  'Lease ' || l.code || ' expired on ' || l.end_date || ' with no active renewal' as description,
  l.province_code,
  l.id::text as record_id,
  'lease' as entity_name,
  l.created_at
FROM lms.lease l
WHERE l.end_date < CURRENT_DATE AND l.stage_code = 'Approved'
  AND NOT EXISTS (SELECT 1 FROM lms.lease_renewal lr WHERE lr.lease_id = l.id);

-- View: GIS Cadastral Coverage Audit
CREATE OR REPLACE VIEW api.v_gis_coverage AS
SELECT 
  p.id as project_id,
  p.code as project_code,
  p.name as project_name,
  p.province_code,
  count(DISTINCT s.id) as total_surveys,
  count(DISTINCT feat.id) as mapped_features,
  count(DISTINCT s.id) - count(DISTINCT feat.survey_id) as unmapped_surveys,
  ROUND(
    CASE WHEN count(DISTINCT s.id) > 0 
      THEN (count(DISTINCT feat.survey_id)::numeric / count(DISTINCT s.id)::numeric) * 100 
      ELSE 0 
    END, 1
  ) as coverage_percentage
FROM lms.project p
LEFT JOIN lms.project_survey ps ON ps.project_id = p.id
LEFT JOIN lms.survey s ON s.id = ps.survey_id
LEFT JOIN lms.project_spatial_feature feat ON feat.project_id = p.id
GROUP BY p.id, p.code, p.name, p.province_code;

-- Grants to runtime application role
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA lms TO lms_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA lms TO lms_app;
GRANT EXECUTE ON FUNCTION lms.convert_area(numeric, text, text, text) TO lms_app;
GRANT SELECT ON api.v_executive_kpis TO lms_app;
GRANT SELECT ON api.v_project_portfolio TO lms_app;
GRANT SELECT ON api.v_finance_aging TO lms_app;
GRANT SELECT ON api.v_data_quality_audit TO lms_app;
GRANT SELECT ON api.v_gis_coverage TO lms_app;
