-- =====================================================================
-- 0030  Pin search_path on lms.convert_area (from migration 0026)
-- =====================================================================
-- Every routine in the LMS schemas pins its search_path so a caller cannot
-- shadow a function or operator it relies on (asserted by test_10). The
-- function added in 0026 did not.
--
-- Not changed here, and recorded as a finding instead (DB-13): this function
-- duplicates api.convert_area with hard-coded factors. api.convert_area reads
-- the versioned lms.unit_conversion table and refuses the two factors the
-- client has not confirmed (Jireb, Bigha) unless the caller opts in; this one
-- converts them silently, and adds units (killa, murabba, wiswa, bega) that the
-- reference table does not hold. Whether those units are wanted is a business
-- decision for the module's owner; the two functions should become one.
SET ROLE lms_owner;
ALTER FUNCTION lms.convert_area(numeric, text, text, text) SET search_path = pg_catalog, pg_temp;
