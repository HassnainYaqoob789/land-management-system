-- =====================================================================
-- 0033  DBPFC rate history is written by its trigger, not by the caller
-- =====================================================================
-- Inserting or re-rating a DBPFC estimate fires lms.tg_dbpfc_rate_history(),
-- which appends to lms.dbpfc_rate_history. The trigger ran with the caller's
-- rights, and the application role rightly has no INSERT on that history
-- table (migration 0029), so every estimate the application tried to create
-- or re-rate failed with "permission denied for table dbpfc_rate_history".
--
-- Granting the application INSERT would let it write rate history that no
-- rate change produced. Instead the trigger runs with its owner's rights, so
-- history can only appear as a side effect of a real change to an estimate —
-- the same arrangement as the other append-only histories. Its search_path is
-- already pinned (pg_catalog, pg_temp).
SET ROLE lms_owner;
ALTER FUNCTION lms.tg_dbpfc_rate_history() SECURITY DEFINER;
REVOKE ALL ON FUNCTION lms.tg_dbpfc_rate_history() FROM PUBLIC;
RESET ROLE;
