-- =====================================================================
-- 0054  One group mapping per (provider, group, role, position, province)
-- =====================================================================
-- iam.group_mapping's UNIQUE (provider_id, external_group, role_id,
-- approval_group, province_code) never fired for an ordinary mapping: such a
-- row has approval_group and province_code NULL, and NULLs are distinct in a
-- plain unique constraint. The same directory group could be mapped to the
-- same role any number of times (the API answered 201, not 409).
-- Found by tests/iam/sso.test.ts against the test IdPs on 2026-10-30.
--
-- Duplicates already present are removed (one row of each kept: the rows are
-- identical in every column but id), then the rule is re-created with
-- NULLS NOT DISTINCT (PostgreSQL 15+).

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);

DELETE FROM iam.group_mapping g
 USING iam.group_mapping k
 WHERE g.provider_id = k.provider_id
   AND g.external_group = k.external_group
   AND g.role_id IS NOT DISTINCT FROM k.role_id
   AND g.approval_group IS NOT DISTINCT FROM k.approval_group
   AND g.province_code IS NOT DISTINCT FROM k.province_code
   AND g.id > k.id;

ALTER TABLE iam.group_mapping
  DROP CONSTRAINT group_mapping_provider_id_external_group_role_id_approval_g_key;
ALTER TABLE iam.group_mapping
  ADD CONSTRAINT group_mapping_unique_rule
  UNIQUE NULLS NOT DISTINCT (provider_id, external_group, role_id, approval_group, province_code);

RESET ROLE;
