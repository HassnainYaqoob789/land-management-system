-- =====================================================================
-- 0049  Landowner statement: one amount basis for every payment line
-- =====================================================================
-- Until now "Compensation paid" showed the GROSS settled amount (net cheque +
-- withholding tax) while "Other payment (not compensation)" showed the NET
-- cheque. Adding the Amount column therefore matched neither the balance nor
-- "Paid to date" (found in the 2026-10-30 statement review, finding F1).
--
-- Now every payment line is GROSS, and its description gives the cheque (net)
-- and the withholding tax, so the reader sees both. For a voucher that is
-- partly allocated to cases, the unallocated part is grossed up in the
-- voucher's own gross:net ratio. Signs are unchanged: other payments still
-- do not move the compensation balance (sign 0), so the balance is exactly
-- what it was.
-- Only the "Other payment" branch differs from 0043; the rest is copied as is.

SET ROLE lms_owner;

CREATE OR REPLACE FUNCTION api.report_landowner_statement(p_landowner_id uuid)
 RETURNS TABLE(landowner_code record_code, full_name text, cnic cnic, entry_date date, entry_type text, reference record_code, description text, amount numeric, running_total numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH lo AS (
    SELECT l.id, l.code, l.full_name, l.cnic FROM lms.landowner l WHERE l.id = p_landowner_id
  ), own AS (
    SELECT om.case_id, om.share_pct, om.owner_count, om.attributed_payable, c.code AS case_code, c.approved_at, c.total_amount
    FROM lms.case_owner_money om JOIN lms.compensation_case c ON c.id = om.case_id
    WHERE om.landowner_id = p_landowner_id AND om.stage_code = 'HO Approved'
  ), adj AS (
    SELECT a.case_id, a.created_at, a.amount, a.reason, round(a.amount * own.share_pct / 100, 2) AS share_amount
    FROM lms.case_adjustment a JOIN own ON own.case_id = a.case_id
  ), pays AS (
    SELECT s.*, own.case_code, pr.code AS voucher_code
    FROM lms.allocation_settlement s
    JOIN own ON own.case_id = s.case_id
    JOIN lms.payment_request pr ON pr.id = s.payment_id
    WHERE s.release_id IS NOT NULL
      AND (s.landowner_id = p_landowner_id OR (s.landowner_id IS NULL AND own.owner_count = 1))
  ), other AS (
    SELECT rel.cheque_date, rel.cheque_no, pr.code, pr.category_code,
           (rel.released_amount - coalesce((SELECT sum(al.amount) FROM lms.payment_allocation al WHERE al.payment_id = pr.id), 0))::numeric AS net,
           pr.gross_amount, pr.net_amount
    FROM lms.payment_release rel
    JOIN lms.payment_request pr ON pr.id = rel.payment_id
    WHERE pr.landowner_id = p_landowner_id
      AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = rel.id)
      AND rel.released_amount > coalesce((SELECT sum(al.amount) FROM lms.payment_allocation al WHERE al.payment_id = pr.id), 0)
  ), other_g AS (
    SELECT other.*,
           CASE WHEN coalesce(other.net_amount, 0) > 0
                THEN round(other.net * other.gross_amount / other.net_amount, 2)
                ELSE other.net END AS gross
    FROM other
  ), entries AS (
    SELECT own.approved_at::date AS entry_date, 1 AS ord, 'Compensation approved'::text AS entry_type, own.case_code::text AS reference,
           format('share %s%% of the approved award of %s', own.share_pct, own.total_amount) AS description,
           (own.attributed_payable - coalesce((SELECT sum(adj.share_amount) FROM adj WHERE adj.case_id = own.case_id), 0))::numeric AS amount,
           1 AS sign
    FROM own
    UNION ALL
    SELECT adj.created_at::date, 2, 'Award adjustment', (SELECT case_code FROM own WHERE own.case_id = adj.case_id)::text,
           format('share of an adjustment of %s: %s', adj.amount, adj.reason), adj.share_amount, 1
    FROM adj
    UNION ALL
    SELECT pays.cheque_date, 3, 'Compensation paid', pays.voucher_code::text,
           format('case %s · cheque %s · net %s + withholding tax %s', pays.case_code, pays.cheque_no,
                  pays.allocated_net, pays.settled_gross - pays.allocated_net),
           pays.settled_gross, -1
    FROM pays
    UNION ALL
    SELECT pays.reversed_at::date, 4, 'Payment reversed', pays.voucher_code::text,
           format('case %s · cheque %s reversed', pays.case_code, pays.cheque_no), pays.settled_gross, 1
    FROM pays WHERE pays.reversal_id IS NOT NULL
    UNION ALL
    SELECT other_g.cheque_date, 5, 'Other payment (not compensation)', other_g.code::text,
           format('%s · cheque %s · net %s + withholding tax %s · not allocated to a compensation case',
                  other_g.category_code, other_g.cheque_no, other_g.net, other_g.gross - other_g.net),
           other_g.gross, 0
    FROM other_g
  )
  SELECT lo.code, lo.full_name, lo.cnic, e.entry_date, e.entry_type, e.reference::lms.record_code, e.description, e.amount,
         sum(e.amount * e.sign) OVER (ORDER BY e.entry_date, e.ord, e.reference ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  FROM entries e CROSS JOIN lo
  ORDER BY e.entry_date, e.ord, e.reference;
$function$;

COMMENT ON FUNCTION api.report_landowner_statement(uuid) IS
  'One landowner''s statement: approved compensation (+), adjustments, compensation paid (-), reversals (+), and other payments (no effect on the balance). Every payment amount is GROSS (net cheque + withholding tax); the description gives both. Runs as the caller: row-level security applies.';

RESET ROLE;
