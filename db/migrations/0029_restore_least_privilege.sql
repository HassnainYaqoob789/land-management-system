-- =====================================================================
-- 0029  Restore least privilege after migration 0026
-- =====================================================================
-- 0026 ended with
--     GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA lms TO lms_app;
--     GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA lms TO lms_app;
-- which gave the application role INSERT / UPDATE / DELETE / TRUNCATE on every
-- table, including the ones the design withholds on purpose: the payment
-- release ledger, workflow decisions, ownership history, idempotency keys, the
-- outbox, configuration and its history, unit conversion factors and the
-- workflow definitions themselves — and USAGE on the cheque-number sequence.
-- With that, a bug or a compromised application could record a payment
-- release with no approval behind it, or truncate the approval history.
-- db/tests/test_10_roles_grants.sql caught it.
--
-- The fix is structural: lms_app holds NO direct privileges. Everything it may
-- do comes through the lms_readwrite group role (db/bootstrap/01_roles.sql,
-- migration 0017), so revoking direct grants cannot remove anything the design
-- intends, and a future blanket grant to lms_app will be caught by the test.
SET ROLE lms_owner;

REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA lms FROM lms_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA lms FROM lms_app;
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA api FROM lms_app;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA lms, api FROM lms_app;

-- What the 0024-0026 modules legitimately need, through the group role.
GRANT SELECT, INSERT, UPDATE ON lms.land_request TO lms_readwrite;
-- A land request is withdrawn through its workflow, not erased.
REVOKE DELETE ON lms.land_request FROM lms_readwrite;
GRANT SELECT ON api.v_lease_register, api.v_executive_kpis, api.v_project_portfolio,
               api.v_finance_aging, api.v_data_quality_audit, api.v_gis_coverage TO lms_readwrite;
GRANT EXECUTE ON FUNCTION lms.convert_area(numeric, text, text, text) TO lms_readwrite;
