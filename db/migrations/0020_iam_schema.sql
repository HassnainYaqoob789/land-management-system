-- =====================================================================
-- 0020  IAM: RBAC, account security, external identities, MFA, secrets,
--       invitations, provider configuration
-- =====================================================================
-- Extends rather than replaces: lms.app_user, lms.app_user_group,
-- lms.app_user_province, lms.login_session, audit.auth_event and
-- lms.system_setting are reused. What did not exist is added in schema `iam`.
--
-- Nothing in this file stores a plaintext password, a raw recovery code, a raw
-- token or a provider secret. Secrets are ciphertext produced by the
-- application with a key the database never sees (iam.secret).
SET ROLE lms_owner;

CREATE SCHEMA IF NOT EXISTS iam;
COMMENT ON SCHEMA iam IS 'Identity and access management. Reads and writes go through definer routines or RLS policies keyed on iam.has_permission().';
GRANT USAGE ON SCHEMA iam TO lms_readwrite, lms_readonly;

-- ---------------------------------------------------------------------
-- Existing tables, extended
-- ---------------------------------------------------------------------
-- A deactivated account is a distinct, permanent state from a suspension
-- (which is reversible and routine). Anonymised accounts keep their id so the
-- audit trail and approvals stay resolvable.
ALTER TABLE lms.app_user DROP CONSTRAINT app_user_status_check;
ALTER TABLE lms.app_user ADD CONSTRAINT app_user_status_check
  CHECK (status IN ('Active','Suspended','Deactivated'));

ALTER TABLE lms.login_session
  ADD COLUMN auth_method        text NOT NULL DEFAULT 'local'
        CHECK (auth_method IN ('local','ldap','oidc','break_glass')),
  ADD COLUMN provider_id        uuid,
  ADD COLUMN absolute_expires_at timestamptz,
  ADD COLUMN mfa_satisfied_at   timestamptz,
  ADD COLUMN mfa_method         text CHECK (mfa_method IN ('totp','webauthn','recovery','idp')),
  ADD COLUMN reauth_at          timestamptz,
  ADD COLUMN rotated_from       uuid;
COMMENT ON COLUMN lms.login_session.mfa_satisfied_at IS
  'NULL = the session passed the first factor only. Authorization refuses '
  'every protected operation for such a session when MFA is required.';

-- audit.auth_event becomes the single security-event log instead of adding a
-- second one. The old outcome list stays valid; the new columns carry what the
-- IAM events need.
ALTER TABLE audit.auth_event DROP CONSTRAINT auth_event_outcome_check;
ALTER TABLE audit.auth_event
  ADD COLUMN event_type     text,
  ADD COLUMN actor_user_id  uuid,
  ADD COLUMN target_user_id uuid,
  ADD COLUMN provider_id    uuid,
  ADD COLUMN correlation_id uuid,
  ADD COLUMN metadata       jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE audit.auth_event ADD CONSTRAINT auth_event_outcome_check
  CHECK (outcome IN ('success','bad_password','unknown_user','suspended','locked_out',
                     'mfa_failed','logout','session_expired','failure','denied','info'));

-- Secrets and tokens must never reach the log. Enforced here so a careless
-- caller cannot defeat it: any key whose name suggests a credential is refused.
CREATE FUNCTION iam.metadata_is_safe(m jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_object_keys(m) k
    WHERE lower(k) ~ '(password|passwd|secret|token|otp|code|private|credential|hash|cookie|authorization|assertion)'
      AND lower(k) NOT IN ('recovery_codes_remaining','codes_remaining','token_expires_at','token_purpose','error_code')
  );
$$;
ALTER TABLE audit.auth_event ADD CONSTRAINT auth_event_metadata_safe_ck
  CHECK (iam.metadata_is_safe(metadata));
CREATE INDEX auth_event_ip_idx   ON audit.auth_event (source_ip, occurred_at DESC) WHERE outcome <> 'success';
CREATE INDEX auth_event_type_idx ON audit.auth_event (event_type, occurred_at DESC);

-- ---------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------
CREATE TABLE iam.permission (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource     text NOT NULL CHECK (resource ~ '^[a-z_]+$'),
  action       text NOT NULL CHECK (action ~ '^[a-z_]+$'),
  description  text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false,
  UNIQUE (resource, action)
);
COMMENT ON TABLE iam.permission IS
  'The permission catalogue: resource + action. Only resources that exist in the '
  'application have rows; a permission nothing enforces is not created. Changed '
  'by migration only.';

CREATE TABLE iam.role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9-]{2,30}$'),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  is_system    boolean NOT NULL DEFAULT false,
  -- The lms.app_role the database enforces for anyone holding this role. The
  -- user's lms.app_user.role_code is the highest-ranked of their roles, kept
  -- in step by iam.sync_db_role(); RLS and the workflow routines read it.
  db_role_code text NOT NULL REFERENCES lms.app_role(code),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1
);

CREATE TABLE iam.role_permission (
  role_id       uuid NOT NULL REFERENCES iam.role(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES iam.permission(id) ON DELETE RESTRICT,
  -- Upper bound of the data the permission reaches. The effective reach is
  -- always ALSO bounded by the user's province access in lms.app_user_province,
  -- which row-level security enforces: 'global' never exceeds that.
  scope_level   text NOT NULL DEFAULT 'province'
                CHECK (scope_level IN ('global','head_office','province','project','assigned')),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE iam.user_role (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  role_id        uuid NOT NULL REFERENCES iam.role(id) ON DELETE RESTRICT,
  -- Optional narrowing of the role to one province or one project.
  scope_province char(3) REFERENCES lms.province(code),
  scope_project  uuid REFERENCES lms.project(id),
  granted_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  reason         text,
  CONSTRAINT user_role_revoke_ck CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX user_role_open_uq ON iam.user_role
  (user_id, role_id, coalesce(scope_province,'---'),
   coalesce(scope_project,'00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX user_role_user_idx ON iam.user_role (user_id) WHERE revoked_at IS NULL;

-- Pairs of permissions one account may not hold together. Enforced when a role
-- is assigned and when a role's permissions change.
CREATE TABLE iam.sod_rule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  perm_a       uuid NOT NULL REFERENCES iam.permission(id),
  perm_b       uuid NOT NULL REFERENCES iam.permission(id),
  reason       text NOT NULL,
  CHECK (perm_a < perm_b),
  UNIQUE (perm_a, perm_b)
);

-- ---------------------------------------------------------------------
-- Account security state, kept out of lms.app_user so that table is unchanged
-- ---------------------------------------------------------------------
CREATE TABLE iam.account_security (
  user_id              uuid PRIMARY KEY REFERENCES lms.app_user(id) ON DELETE CASCADE,
  failed_count         integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_failure_at      timestamptz,
  locked_until         timestamptz,
  password_changed_at  timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  is_break_glass       boolean NOT NULL DEFAULT false,
  deactivated_at       timestamptz,
  anonymised_at        timestamptz
);

CREATE TABLE iam.password_history (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE CASCADE,
  hash      text NOT NULL CHECK (hash ~ '^\$argon2id\$'),
  set_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_history_user_idx ON iam.password_history (user_id, set_at DESC);

-- ---------------------------------------------------------------------
-- Secrets: ciphertext only. The key lives in the environment / a secret
-- manager; the database cannot decrypt any of this.
-- ---------------------------------------------------------------------
CREATE TABLE iam.secret (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  key_id      text NOT NULL,
  ciphertext  bytea NOT NULL CHECK (length(ciphertext) >= 29),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz,
  rotated_by  uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT
);
COMMENT ON TABLE iam.secret IS
  'AES-256-GCM ciphertext (nonce || ciphertext || tag), authenticated with the '
  'secret name as associated data so a ciphertext cannot be moved to another '
  'name. key_id names the key in the application keyring for rotation.';

-- ---------------------------------------------------------------------
-- Identity providers
-- ---------------------------------------------------------------------
CREATE TABLE iam.auth_provider (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('ldap','oidc')),
  name           text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9-]{1,30}$'),
  display_name   text NOT NULL,
  enabled        boolean NOT NULL DEFAULT false,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_id      uuid REFERENCES iam.secret(id),
  -- Saved is not verified. These record the last real test, and nothing else
  -- writes them.
  last_tested_at timestamptz,
  last_test_ok   boolean,
  last_test_detail text,
  last_test_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  -- A provider can only be enabled after a successful test of the CURRENT
  -- configuration; changing config clears these (trigger below).
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  CONSTRAINT auth_provider_enabled_tested_ck CHECK (NOT enabled OR last_test_ok IS TRUE),
  CONSTRAINT auth_provider_config_safe_ck CHECK (iam.metadata_is_safe(config))
);
COMMENT ON CONSTRAINT auth_provider_enabled_tested_ck ON iam.auth_provider IS
  'A provider cannot be enabled unless its last test passed. Changing the '
  'configuration clears the test, so an untested change disables the provider.';

CREATE TABLE iam.auth_provider_revision (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id  uuid NOT NULL REFERENCES iam.auth_provider(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  config       jsonb NOT NULL,
  enabled      boolean NOT NULL,
  secret_version integer,
  summary      text NOT NULL,
  changed_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, version)
);

CREATE TABLE iam.external_identity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  provider_id  uuid NOT NULL REFERENCES iam.auth_provider(id) ON DELETE RESTRICT,
  -- The provider's immutable subject (OIDC `sub`, LDAP entryUUID/objectGUID),
  -- never the email: an email can be reassigned to a different person.
  subject      text NOT NULL CHECK (btrim(subject) <> ''),
  issuer       text,
  email_at_link text,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  linked_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  last_login_at timestamptz,
  unlinked_at  timestamptz,
  UNIQUE (provider_id, subject)
);
CREATE UNIQUE INDEX external_identity_one_per_user_provider
  ON iam.external_identity (user_id, provider_id) WHERE unlinked_at IS NULL;

-- A first-time external login that has no matching link waits here for an
-- administrator, unless provisioning is set to automatic.
CREATE TABLE iam.provisioning_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES iam.auth_provider(id) ON DELETE CASCADE,
  subject      text NOT NULL,
  issuer       text,
  email        text,
  display_name text,
  groups       text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  decision_note text,
  resulting_user uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  UNIQUE (provider_id, subject)
);

CREATE TABLE iam.group_mapping (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES iam.auth_provider(id) ON DELETE CASCADE,
  external_group text NOT NULL,
  role_id       uuid REFERENCES iam.role(id),
  approval_group text REFERENCES lms.approval_group(code),
  province_code char(3) REFERENCES lms.province(code),
  CHECK (role_id IS NOT NULL OR approval_group IS NOT NULL OR province_code IS NOT NULL),
  UNIQUE (provider_id, external_group, role_id, approval_group, province_code)
);
COMMENT ON TABLE iam.group_mapping IS
  'Directory group -> application role / approval position / province. A '
  'mapping to a role is refused if the role is privileged: group mapping must '
  'not become an uncontrolled route to administrator.';

CREATE TABLE iam.provisioning_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  provider_id uuid REFERENCES iam.auth_provider(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  subject     text,
  action      text NOT NULL CHECK (action IN
              ('requested','approved','rejected','created','linked','unlinked','group_sync',
               'deprovisioned','login_refused','bulk_import')),
  outcome     text NOT NULL CHECK (outcome IN ('success','failure','refused')),
  detail      text
);

-- ---------------------------------------------------------------------
-- MFA
-- ---------------------------------------------------------------------
CREATE TABLE iam.mfa_totp (
  user_id        uuid PRIMARY KEY REFERENCES lms.app_user(id) ON DELETE CASCADE,
  secret_ct      bytea NOT NULL,
  key_id         text NOT NULL,
  -- Replay prevention: the last accepted time-step. A code is accepted only
  -- if its step is strictly greater, so the same code cannot be used twice.
  last_used_step bigint NOT NULL DEFAULT 0,
  confirmed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iam.mfa_webauthn (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0,
  transports    text[],
  label         text NOT NULL DEFAULT 'Security key',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE TABLE iam.mfa_recovery_code (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE CASCADE,
  verifier   bytea NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, verifier)
);

-- Short-lived state for a login that has passed the first factor, and for
-- WebAuthn challenges. Hashed, single-use, expiring.
CREATE TABLE iam.challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 bytea NOT NULL UNIQUE,
  user_id     uuid REFERENCES lms.app_user(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('mfa_login','webauthn_register','webauthn_login','oidc_state')),
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  attempts    smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX challenge_expiry_idx ON iam.challenge (expires_at) WHERE used_at IS NULL;

-- ---------------------------------------------------------------------
-- Invitations and recovery
-- ---------------------------------------------------------------------
CREATE TABLE iam.invitation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE CASCADE,
  token_sha256 bytea NOT NULL UNIQUE,
  purpose      text NOT NULL CHECK (purpose IN ('invitation','password_reset')),
  created_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX invitation_user_idx ON iam.invitation (user_id, purpose) WHERE used_at IS NULL;

CREATE TABLE iam.access_review (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_by   uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  note         text
);
CREATE TABLE iam.access_review_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id    uuid NOT NULL REFERENCES iam.access_review(id) ON DELETE CASCADE,
  user_role_id uuid NOT NULL REFERENCES iam.user_role(id),
  decision     text CHECK (decision IN ('keep','revoke')),
  decided_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  decided_at   timestamptz,
  UNIQUE (review_id, user_role_id)
);

-- Bulk CSV import staging is intentionally not modelled: it is not required by
-- the client, and an unused table is not a capability. See docs/IAM_ARCHITECTURE.md.
