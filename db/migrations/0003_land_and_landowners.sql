-- =====================================================================
-- 0003  Projects, surveys (parcels), landowners and ownership shares
-- =====================================================================
SET ROLE lms_owner;

-- Lets a child table carry province_code and have PostgreSQL itself keep it
-- consistent with the parent unit, through a composite foreign key, instead of
-- a trigger. Redundant as an index, load-bearing as a constraint target.
ALTER TABLE lms.admin_unit ADD CONSTRAINT admin_unit_id_province_uq UNIQUE (id, province_code);
COMMENT ON CONSTRAINT admin_unit_id_province_uq ON lms.admin_unit IS
  'Exists so child tables can reference (id, province_code) and have the '
  'province kept consistent declaratively rather than by trigger.';

-- ---------------------------------------------------------------------
-- Projects and well locations
-- ---------------------------------------------------------------------
CREATE TABLE lms.project_type (
  code text PRIMARY KEY,
  name text NOT NULL,
  display_order smallint NOT NULL DEFAULT 100
);

CREATE TABLE lms.project (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The project code is the company's own convention (DHRK-001 for a location,
  -- DHRK-10P for a pipeline) and is quoted in every document, so it is the
  -- natural key rather than a surrogate the user never sees.
  code           lms.record_code NOT NULL UNIQUE,
  name           text NOT NULL CHECK (btrim(name) <> ''),
  type_code      text NOT NULL REFERENCES lms.project_type(code) ON DELETE RESTRICT,
  block          text NOT NULL CHECK (btrim(block) <> ''),
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  district_id    uuid NOT NULL,
  required_area  lms.area_acres,
  lat            lms.latitude,
  lng            lms.longitude,
  status         text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Completed','Cancelled')),
  description    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  -- district_id must be a district (level 0) in this project's province. The
  -- composite key covers the province half declaratively; the level-0 half is
  -- checked by lms.tg_project_district() in 0012.
  CONSTRAINT project_district_fk FOREIGN KEY (district_id, province_code)
    REFERENCES lms.admin_unit(id, province_code) ON DELETE RESTRICT,
  -- Coordinates come as a pair or not at all; one alone is a data-entry slip.
  CONSTRAINT project_coords_ck CHECK ((lat IS NULL) = (lng IS NULL))
);
COMMENT ON TABLE lms.project IS
  'Wells, pipelines, camps, compressor stations and access roads: the master '
  'list every compensation case, lease and payment points at.';

-- ---------------------------------------------------------------------
-- Surveys — the land parcels, keyed by the province's own revenue number
-- ---------------------------------------------------------------------
CREATE TABLE lms.land_status (
  code text PRIMARY KEY,
  name text NOT NULL,
  display_order smallint NOT NULL DEFAULT 100,
  is_held boolean NOT NULL DEFAULT false
);
COMMENT ON COLUMN lms.land_status.is_held IS 'true once the company holds the parcel (Acquired, Leased): used by the land-status views.';

CREATE TABLE lms.survey (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  admin_unit_id  uuid NOT NULL,
  -- Survey No. in Sindh, Khasra No. elsewhere; the label comes from
  -- lms.province.revenue_key_label.
  survey_no      text NOT NULL CHECK (btrim(survey_no) <> ''),
  -- Sindh additionally has a Block No.; other provinces leave it null.
  block_no       text,
  -- KPK distinguishes rural (Khasra) from urban (Survey) numbering.
  khasra_type    text CHECK (khasra_type IN ('Rural','Urban')),
  total_area     lms.area_acres NOT NULL CHECK (total_area > 0),
  land_class     text NOT NULL CHECK (land_class IN ('Private','Government')),
  status_code    text NOT NULL REFERENCES lms.land_status(code) ON DELETE RESTRICT,
  lat            lms.latitude,
  lng            lms.longitude,
  remarks        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT survey_admin_unit_fk FOREIGN KEY (admin_unit_id, province_code)
    REFERENCES lms.admin_unit(id, province_code) ON DELETE RESTRICT,
  CONSTRAINT survey_coords_ck CHECK ((lat IS NULL) = (lng IS NULL))
);
COMMENT ON TABLE lms.survey IS
  'Land parcels. total_area is the whole survey as the revenue record states '
  'it; the part the company occupies is the sum of its lease lines, not a column here.';

-- The revenue number is unique within the lowest administrative unit, with the
-- Sindh block number as part of the key. A functional unique index rather than
-- a table constraint, because the comparison has to be case-insensitive and
-- has to treat a missing block number as a value rather than as "unknown" —
-- a plain UNIQUE would let (Deh A, 123, NULL) be inserted twice.
CREATE UNIQUE INDEX survey_revenue_key_uq
  ON lms.survey (admin_unit_id, lower(survey_no), coalesce(lower(block_no), ''));
COMMENT ON INDEX lms.survey_revenue_key_uq IS
  'One parcel per revenue number per unit. coalesce() is required: NULL block_no '
  'would otherwise bypass uniqueness, since NULL <> NULL in a UNIQUE constraint.';

-- Which projects a parcel serves. Many-to-many: one parcel can host a well
-- pad and be crossed by that well's flowline.
CREATE TABLE lms.project_survey (
  project_id uuid NOT NULL REFERENCES lms.project(id) ON DELETE CASCADE,
  survey_id  uuid NOT NULL REFERENCES lms.survey(id)  ON DELETE RESTRICT,
  PRIMARY KEY (project_id, survey_id)
);
COMMENT ON TABLE lms.project_survey IS
  'ON DELETE CASCADE on project, RESTRICT on survey: cancelling a project drops '
  'its links, but a parcel that is still linked cannot be deleted out from under one.';

-- ---------------------------------------------------------------------
-- Landowners. CNIC is the business key and the duplicate the prototype had to
-- prevent in application code; here it is a unique constraint, which holds
-- under concurrency as an application check cannot.
-- ---------------------------------------------------------------------
CREATE TABLE lms.landowner (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  full_name      text NOT NULL CHECK (btrim(full_name) <> ''),
  father_name    text NOT NULL CHECK (btrim(father_name) <> ''),
  cnic           lms.cnic NOT NULL UNIQUE,
  phone          text,
  owner_type     char(1) NOT NULL CHECK (owner_type IN ('O','B','A')),
  status         text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Deceased','Inactive')),
  tax_status     text CHECK (tax_status IN ('Filer','Non-Filer')),
  bank_branch    text,
  -- Pakistani IBAN: PK, 2 check digits, 4-letter bank code, 16 alphanumerics.
  iban           text CHECK (iban IS NULL OR iban ~ '^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$'),
  address        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE lms.landowner IS
  'One row per person, keyed by CNIC. owner_type: O owner, A attorney, B both.';
COMMENT ON CONSTRAINT landowner_cnic_key ON lms.landowner IS
  'The duplicate-landowner rule. The prototype checked this in JavaScript '
  'before inserting, which two concurrent requests can both pass; a unique '
  'constraint cannot be raced.';

-- ---------------------------------------------------------------------
-- Ownership shares: who owns what fraction of which parcel, per the revenue
-- record (Form VII-B and equivalents).
--
-- The invariant is that the shares on one parcel never total more than 100%.
-- That cannot be a CHECK — it spans rows — so it is a DEFERRABLE constraint
-- trigger (see 0012). Deferred is the right choice rather than immediate: a
-- mutation moves a 100% holding from one owner to several heirs, and an
-- immediate check would reject the intermediate state partway through a
-- perfectly valid transaction. Deferred means the rule is enforced at COMMIT,
-- when the transaction's intent is complete.
-- ---------------------------------------------------------------------
CREATE TABLE lms.survey_ownership_share (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id        uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  landowner_id     uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  share_pct        lms.share_pct NOT NULL,
  revenue_doc_ref  text,
  effective_from   date NOT NULL DEFAULT current_date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version          integer NOT NULL DEFAULT 1,
  -- One holding row per owner per parcel: a second share for the same person
  -- on the same parcel is a correction to the first, not a new holding.
  UNIQUE (survey_id, landowner_id)
);
COMMENT ON TABLE lms.survey_ownership_share IS
  'Share of a parcel per landowner. Totals are capped at 100% by a deferred '
  'constraint trigger so that a mutation can redistribute shares mid-transaction.';

-- Ownership history, so a transfer does not erase what came before. Written by
-- the mutation routine, never by the application directly.
CREATE TABLE lms.survey_ownership_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  survey_id       uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  landowner_id    uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  share_pct       numeric(7,4) NOT NULL,
  valid_from      date NOT NULL,
  valid_to        date,
  change_reason   text NOT NULL,
  mutation_id     uuid,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  recorded_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  CONSTRAINT survey_ownership_history_period_ck CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
COMMENT ON TABLE lms.survey_ownership_history IS
  'Closed-out ownership rows. A mutation closes the transferor''s row and opens '
  'the heirs'' rows, so "who owned this parcel in 2023" stays answerable.';
CREATE INDEX survey_ownership_history_survey_idx
  ON lms.survey_ownership_history (survey_id, valid_from DESC);
