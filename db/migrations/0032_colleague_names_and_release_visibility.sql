-- =====================================================================
-- 0032  Colleague names without exposing the user table
-- =====================================================================
-- lms.app_user's row-level security (own_or_admin) shows each person only
-- their own account row. That is right for the account itself, but two views
-- INNER JOIN it just to print who acted, so for anyone but an administrator
-- the join drops the whole row:
--
--   api.v_payment_release        a finance officer sees no cheque releases
--                                made by anyone else
--   api.v_record_version_history a reviewer sees no history written by others
--
-- The fix does not widen the user table. Two definer functions return only a
-- username or a display name for an id — what any colleague may already see on
-- a signed document — and the views use them instead of the join.
SET ROLE lms_owner;

CREATE FUNCTION lms.user_username(p_id uuid) RETURNS lms.app_user.username%TYPE
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT u.username FROM lms.app_user u WHERE u.id = p_id $$;

CREATE FUNCTION lms.user_full_name(p_id uuid) RETURNS lms.app_user.full_name%TYPE
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT u.full_name FROM lms.app_user u WHERE u.id = p_id $$;

COMMENT ON FUNCTION lms.user_username(uuid) IS
  'Username for an id, for "who did this" columns. Returns nothing else about the account.';
COMMENT ON FUNCTION lms.user_full_name(uuid) IS
  'Display name for an id, for "who did this" columns. Returns nothing else about the account.';

REVOKE ALL ON FUNCTION lms.user_username(uuid), lms.user_full_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.user_username(uuid), lms.user_full_name(uuid) TO lms_readwrite, lms_readonly;

CREATE OR REPLACE VIEW api.v_payment_release WITH (security_invoker = true) AS
 SELECT r.id AS release_id,
    pr.id AS payment_id,
    pr.code AS voucher_code,
    pr.province_code,
    p.code AS project_code,
    COALESCE(lo.full_name, pr.payee_name) AS payee,
    lo.code AS landowner_code,
    lo.cnic,
    pr.category_code,
    pr.pay_type,
    pr.period_from,
    pr.period_to,
    pr.gross_amount,
    pr.wht_amount,
    pr.net_amount,
    r.cheque_no,
    r.cheque_date,
    r.released_amount,
    r.released_at,
    lms.user_username(r.released_by) AS released_by,
    ( SELECT count(*) AS count
           FROM lms.payment_receipt rc
          WHERE rc.release_id = r.id) AS receipt_count,
    cc.code AS case_code,
    l.code AS lease_code
   FROM lms.payment_release r
     JOIN lms.payment_request pr ON pr.id = r.payment_id
     JOIN lms.project p ON p.id = pr.project_id
     LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
     LEFT JOIN lms.compensation_case cc ON cc.id = pr.case_id
     LEFT JOIN lms.lease l ON l.id = pr.lease_id;

CREATE OR REPLACE VIEW api.v_record_version_history WITH (security_invoker = true) AS
 SELECT v.id,
    v.entity,
    v.record_id,
    v.version,
    v.province_code,
    v.valid_from,
    lms.user_username(v.created_by) AS created_by_username,
    v.snapshot,
    lead(v.valid_from) OVER (PARTITION BY v.entity, v.record_id ORDER BY v.version) AS valid_to
   FROM audit.record_version v;

RESET ROLE;
