-- =====================================================================
-- 0002  Reference data, measurement units, organisation and users
-- =====================================================================
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Provinces. Four provinces, each with its own revenue vocabulary and its own
-- depth of administrative hierarchy (Sindh 3 levels, Balochistan 5). The level
-- names are a child table rather than a text[] so that admin_unit.level can
-- carry a foreign key to a level that actually exists in that province.
-- ---------------------------------------------------------------------
CREATE TABLE lms.province (
  code               char(3)  PRIMARY KEY CHECK (code = upper(code)),
  name               text     NOT NULL UNIQUE,
  revenue_key_label  text     NOT NULL,
  revenue_key2_label text,
  centre_lat         lms.latitude,
  centre_lng         lms.longitude,
  display_order      smallint NOT NULL,
  UNIQUE (display_order)
);
COMMENT ON TABLE lms.province IS
  'The four provinces the system covers. revenue_key_label is what the parcel '
  'number is called locally (Survey No. in Sindh, Khasra No. elsewhere).';

CREATE TABLE lms.province_level (
  province_code char(3)  NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  depth         smallint NOT NULL CHECK (depth BETWEEN 0 AND 6),
  name          text     NOT NULL,
  PRIMARY KEY (province_code, depth),
  UNIQUE (province_code, name)
);
COMMENT ON TABLE lms.province_level IS
  'Names of the administrative tiers per province, depth 0 = District. '
  'Sindh: District/Taluka/Deh. Balochistan: District/Sub-Division/Tehsil/Sub-Tehsil/Mouza.';

-- ---------------------------------------------------------------------
-- Measurement units and their conversion factors.
--
-- Area is stored in acres everywhere. Provinces use local units (Ghunta,
-- Kanal, Marla, Jireb, Rod, Pole, Bigha) and a conversion factor is the only
-- thing that relates them. Two of those factors — Jireb and Bigha — vary by
-- district and have not been confirmed by the client, which the prototype
-- flags in Settings. The database carries that flag so a report cannot quietly
-- present an unconfirmed conversion as fact.
--
-- Factors are versioned by validity period rather than overwritten: a lease
-- signed in 2024 must keep converting with the factor that was in force in
-- 2024 even after a correction. The exclusion constraint is what makes the
-- history unambiguous — two rows for one unit may not claim overlapping
-- periods, so "the factor on date D" always has exactly one answer.
-- ---------------------------------------------------------------------
CREATE TABLE lms.measurement_unit (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  is_area       boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL DEFAULT 100
);

CREATE TABLE lms.unit_conversion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_code     text NOT NULL REFERENCES lms.measurement_unit(code) ON DELETE RESTRICT,
  -- Square METRES per unit, to ten decimal places.
  --
  -- The base unit is metric because that is the only choice under which every
  -- factor is exact. The international foot is defined as 0.3048 m exactly, so
  -- one square foot is 0.09290304 m² exactly and one acre is 4046.8564224 m²
  -- exactly; every Pakistani sub-unit is a whole fraction of an acre and so is
  -- exact too. Going the other way — square feet per unit — makes the square
  -- metre itself a non-terminating decimal (1 m² = 10.76391041670972… sq ft),
  -- and a hectare then fails to convert back to exactly 10,000 m². Ten decimal
  -- places hold every factor the system uses with nothing left over.
  sqm_per_unit  numeric(20,10) NOT NULL CHECK (sqm_per_unit > 0),
  valid_from    date NOT NULL,
  valid_to      date,
  -- Half-open period: valid_to NULL means "still in force". 'infinity' keeps
  -- the range type total so the exclusion constraint covers open-ended rows.
  valid_range   daterange GENERATED ALWAYS AS
                  (daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[)')) STORED,
  is_confirmed  boolean NOT NULL DEFAULT false,
  source_ref    text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  CONSTRAINT unit_conversion_period_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT unit_conversion_no_overlap
    EXCLUDE USING gist (unit_code WITH =, valid_range WITH &&)
);
COMMENT ON TABLE lms.unit_conversion IS
  'Versioned square-metres-per-unit factors. api.convert_area() reads this and '
  'nothing else, so a correction applies everywhere at once.';
COMMENT ON COLUMN lms.unit_conversion.is_confirmed IS
  'false = provisional, pending client confirmation (Jireb, Bigha). '
  'api.convert_area() refuses an unconfirmed factor unless the caller opts in.';
COMMENT ON CONSTRAINT unit_conversion_no_overlap ON lms.unit_conversion IS
  'One factor per unit per instant. Without it "the factor on date D" could '
  'return two rows and a conversion would be non-deterministic.';

CREATE TABLE lms.province_unit (
  province_code char(3) NOT NULL REFERENCES lms.province(code) ON DELETE CASCADE,
  unit_code     text    NOT NULL REFERENCES lms.measurement_unit(code) ON DELETE RESTRICT,
  display_order smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (province_code, unit_code)
);
COMMENT ON TABLE lms.province_unit IS 'Which secondary units each province shows alongside acres.';

-- ---------------------------------------------------------------------
-- Administrative hierarchy. Self-referencing tree, one row per District,
-- Taluka, Tehsil, Deh, Mouza and so on. The depth is checked against the
-- province's own level list, and a parent must be exactly one level up and in
-- the same province — the two mistakes that would otherwise produce a Punjab
-- Mouza hanging off a Sindh Taluka.
-- ---------------------------------------------------------------------
CREATE TABLE lms.admin_unit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          lms.record_code NOT NULL UNIQUE,
  province_code char(3)  NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  level         smallint NOT NULL,
  parent_id     uuid REFERENCES lms.admin_unit(id) ON DELETE RESTRICT,
  name          text     NOT NULL CHECK (btrim(name) <> ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer  NOT NULL DEFAULT 1,
  FOREIGN KEY (province_code, level) REFERENCES lms.province_level(province_code, depth),
  -- depth 0 has no parent; every deeper level must have one.
  CONSTRAINT admin_unit_root_ck CHECK ((level = 0) = (parent_id IS NULL)),
  -- A unit name is unique among its siblings, not globally: two provinces may
  -- both have a "Ghotki" district and two talukas may both contain a "Mirpur".
  UNIQUE (province_code, level, parent_id, name)
);
COMMENT ON TABLE lms.admin_unit IS
  'District / Taluka / Tehsil / Qanungo Halka / Deh / Mouza master, one tree per province.';

-- parent must sit exactly one level up, in the same province. Not expressible
-- as a CHECK (it reads another row), so it is a trigger; see 0012.
COMMENT ON COLUMN lms.admin_unit.parent_id IS
  'Parent unit. The "exactly one level up, same province" rule is enforced by '
  'lms.tg_admin_unit_parent() in migration 0012, not by a CHECK, because a '
  'CHECK cannot read another row.';

-- ---------------------------------------------------------------------
-- Organisation, roles and users
-- ---------------------------------------------------------------------
CREATE TABLE lms.app_role (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL,
  -- Rank orders the four roles for the "can this role do at least as much as"
  -- questions the application asks; it is not itself an authorisation rule.
  rank        smallint NOT NULL UNIQUE
);
COMMENT ON TABLE lms.app_role IS 'Admin / Approver / User / Viewer. Matches ROLES in app/assets/js/core/engine.js.';

CREATE TABLE lms.approval_group (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  display_order smallint NOT NULL DEFAULT 100
);
COMMENT ON TABLE lms.approval_group IS
  'Positions a workflow step can be assigned to (Negotiation Group, Legal Advisor, '
  'Finance Officer …). A user acts for one or more of them.';

CREATE TABLE lms.office (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  is_head_office boolean NOT NULL DEFAULT false
);

-- The four roles are seeded here rather than with the rest of the reference
-- data in 0015, because the system service account below needs one and has to
-- exist before the audit triggers do.
INSERT INTO lms.app_role (code, name, description, rank) VALUES
  ('Admin',    'Administrator', 'Full access: configuration, users, all approvals, delete', 4),
  ('Approver', 'Approver',      'Review and approve workflows, create and edit records',    3),
  ('User',     'User',          'Data entry: create and edit drafts, submit for approval, upload documents', 2),
  ('Viewer',   'Viewer',        'Read-only: view records, dashboards and reports, export',  1);

CREATE TABLE lms.app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  username       ext.citext NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,32}$'),
  full_name      text NOT NULL CHECK (btrim(full_name) <> ''),
  role_code      text NOT NULL REFERENCES lms.app_role(code) ON DELETE RESTRICT,
  department     text,
  position       text,
  office_code    text REFERENCES lms.office(code) ON DELETE RESTRICT,
  email          ext.citext CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),
  -- A verifier string from a slow password hash (argon2id or bcrypt), never a
  -- password. The database stores no plaintext and no reversible form; the
  -- CHECK makes a plaintext value impossible to insert by accident.
  password_hash  text CHECK (password_hash IS NULL OR password_hash ~ '^\$(argon2(id|i|d)|2[aby])\$'),
  password_set_at timestamptz,
  status         text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Suspended')),
  -- A service account acts on behalf of the system itself: migrations,
  -- maintenance jobs, the alerting scheduler. It has no password, so the
  -- application has nothing to authenticate it with and cannot sign in as it;
  -- it exists so that those actions are attributed to something nameable in
  -- the audit trail instead of appearing unattributed.
  is_service_account boolean NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer NOT NULL DEFAULT 1,
  -- A service account must have no password; an interactive account must
  -- eventually have one. The second half is not enforced at insert time
  -- because an administrator creates the account before the user sets a
  -- password.
  CONSTRAINT app_user_service_no_password_ck
    CHECK (NOT is_service_account OR password_hash IS NULL)
);
COMMENT ON TABLE lms.app_user IS 'Application accounts. Authentication itself is the application tier''s job; this table holds the verifier.';
COMMENT ON COLUMN lms.app_user.password_hash IS
  'Argon2id or bcrypt verifier. The CHECK rejects anything that is not in a '
  'recognised hash format, so the plaintext passwords the prototype used '
  'cannot be migrated in as-is. See docs/SECURITY_FINDINGS.md APP-01.';

-- Self-reference for the created_by/updated_by columns, added once app_user
-- exists. ON DELETE is deliberately RESTRICT: an account that has touched a
-- record cannot be deleted, only suspended, so the trail stays resolvable.
ALTER TABLE lms.app_user
  ADD CONSTRAINT app_user_created_by_fk FOREIGN KEY (created_by) REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  ADD CONSTRAINT app_user_updated_by_fk FOREIGN KEY (updated_by) REFERENCES lms.app_user(id) ON DELETE RESTRICT;

ALTER TABLE lms.admin_unit
  ADD CONSTRAINT admin_unit_created_by_fk FOREIGN KEY (created_by) REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  ADD CONSTRAINT admin_unit_updated_by_fk FOREIGN KEY (updated_by) REFERENCES lms.app_user(id) ON DELETE RESTRICT;

ALTER TABLE lms.unit_conversion
  ADD CONSTRAINT unit_conversion_created_by_fk FOREIGN KEY (created_by) REFERENCES lms.app_user(id) ON DELETE RESTRICT;

-- The system actor.
--
-- Migrations, maintenance jobs and authorised administrative corrections all
-- write to audited tables, and the audit trigger refuses an unattributed
-- change. Rather than making the trigger tolerate a missing actor — which
-- would leave exactly the holes in the trail that matter most — those paths
-- set the actor to this account. Its id is fixed and documented so a migration
-- can set it without a lookup, and so an audit row attributed to it is
-- recognisable at a glance.
--
-- An audit row written this way still records db_role, so "the system account
-- did it during a migration" and "the system account did it from the
-- application" are distinguishable.
INSERT INTO lms.app_user (id, code, username, full_name, role_code, status,
                          is_service_account, password_hash, department, position)
VALUES ('00000000-0000-0000-0000-000000000001', 'USR-000', 'system',
        'System (migrations and maintenance)', 'Admin', 'Active',
        true, NULL, 'Platform', 'Service account');

CREATE TABLE lms.app_user_group (
  user_id    uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE CASCADE,
  group_code text NOT NULL REFERENCES lms.approval_group(code) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, group_code)
);
COMMENT ON TABLE lms.app_user_group IS 'Which approval positions each user may act for. ON DELETE CASCADE: dropping a user drops their group memberships, nothing else.';

-- The province access list. This is the table every row-level security policy
-- is ultimately asking about.
CREATE TABLE lms.app_user_province (
  user_id       uuid    NOT NULL REFERENCES lms.app_user(id) ON DELETE CASCADE,
  province_code char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, province_code)
);
COMMENT ON TABLE lms.app_user_province IS
  'Province access per user. Head-office staff hold all four rows, field staff one. '
  'Row-level security policies read this through lms.actor_provinces().';

-- ---------------------------------------------------------------------
-- Record code sequences. Codes such as AREA-000001 and CC-2026-0001 are
-- user-facing and must never repeat, including after a rolled-back
-- transaction. A counter table would serialise and could be rolled back; a
-- PostgreSQL sequence is non-transactional on purpose, which is exactly the
-- property a never-reused number needs.
-- ---------------------------------------------------------------------
CREATE TABLE lms.code_sequence (
  prefix     text PRIMARY KEY,
  seq_name   text NOT NULL,
  pad_to     smallint NOT NULL CHECK (pad_to BETWEEN 1 AND 12),
  note       text
);
COMMENT ON TABLE lms.code_sequence IS
  'Registry of the sequences behind user-facing record codes. Gaps are expected '
  'and acceptable (a rolled-back insert burns a number); repeats are not.';

-- ---------------------------------------------------------------------
-- System settings and their history. Settings are a small key/value store
-- rather than one wide row, so a change to the withholding-tax rate is one
-- row's history and not the whole configuration's.
-- ---------------------------------------------------------------------
CREATE TABLE lms.system_setting (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  value_type  text  NOT NULL CHECK (value_type IN ('string','number','boolean','object','array')),
  description text  NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version     integer NOT NULL DEFAULT 1
);

CREATE TABLE lms.setting_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL,
  old_value   jsonb,
  new_value   jsonb NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  note        text
);
COMMENT ON TABLE lms.setting_history IS
  'Every configuration change, append-only. Who changed the withholding rate, '
  'when, and from what — needed for ISO 27001 change evidence (A.8.32).';
CREATE INDEX setting_history_key_at_idx ON lms.setting_history (key, changed_at DESC);
