-- 0024_land_lease_request.sql
-- 4-Tier Land Lease Request Initiation & Approval Workflow (Sample Approval Workflow.pdf)
-- Tier 1: Department Initiator (Operations / Drilling / Exploration)
-- Tier 2: Director Operations (Operational necessity validation)
-- Tier 3: Regional Manager (Regional boundaries, security, community validation)
-- Tier 4: DM / TL Land Affairs (Cadastral allocation, parcel survey & owner identification trigger)

SET search_path = lms, public;

CREATE TABLE IF NOT EXISTS lms.land_request (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   text NOT NULL UNIQUE,
  province_code          character(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  project_id             uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  concession_name        text NOT NULL DEFAULT 'Mari Concession',
  purpose                text NOT NULL,
  area_acres             numeric(12, 4) NOT NULL CHECK (area_acres > 0),
  area_ghunta            numeric(12, 4) DEFAULT 0,
  target_deh             text,
  required_date          date NOT NULL,
  priority               text NOT NULL DEFAULT 'Standard' CHECK (priority IN ('Standard', 'Urgent', 'Emergency')),
  justification          text NOT NULL,
  stage_code             text NOT NULL DEFAULT 'Submitted',
  pending_approver_role  text NOT NULL DEFAULT 'Director Operations',
  director_ops_id        uuid REFERENCES lms.app_user(id),
  director_ops_action    text,
  director_ops_comment   text,
  director_ops_date      timestamptz,
  regional_mgr_id        uuid REFERENCES lms.app_user(id),
  regional_mgr_action    text,
  regional_mgr_comment   text,
  regional_mgr_date      timestamptz,
  land_affairs_id        uuid REFERENCES lms.app_user(id),
  land_affairs_action    text,
  land_affairs_comment   text,
  land_affairs_date      timestamptz,
  allocated_survey_id    uuid REFERENCES lms.survey(id),
  allocated_lease_id     uuid REFERENCES lms.lease(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL REFERENCES lms.app_user(id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid NOT NULL REFERENCES lms.app_user(id),
  version                integer NOT NULL DEFAULT 1
);

ALTER TABLE lms.land_request OWNER TO lms_owner;

GRANT SELECT, INSERT, UPDATE, DELETE ON lms.land_request TO lms_app;
GRANT SELECT ON lms.land_request TO lms_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON lms.land_request TO lms_readwrite;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = 'tg_audit_row' AND n.nspname = 'audit') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'land_request_audit') THEN
      CREATE TRIGGER land_request_audit
        AFTER INSERT OR UPDATE OR DELETE ON lms.land_request
        FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();
    END IF;
  END IF;
END $$;
