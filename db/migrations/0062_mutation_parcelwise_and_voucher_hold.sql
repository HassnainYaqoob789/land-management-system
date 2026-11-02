-- =====================================================================
-- 0062  Mutation re-pointing: parcel-wise split · unreleased vouchers held
-- =====================================================================
-- Decisions on the three questions left open by 0060 / 0061 (2 Nov 2026,
-- docs/reports/CLIENT_REQUIREMENTS_ANALYSIS_2026-11-02.md §10):
--
-- 1. Vouchers already raised for the transferor but not yet released are
--    HELD, not cancelled. A payment-scope hold (lms.payment_hold) is placed on
--    each, so the database refuses to release it (lms.payment_active_hold),
--    and Finance decides: cancel it and raise a new voucher for the new owner,
--    or lift the hold and release it when the amount was earned before the
--    transfer (rent for a period before the sale, crop damage before the
--    death). Cancelling automatically would destroy a financial document and
--    could take money the old owner (or the estate) is owed; leaving it
--    releasable could pay the wrong person. A hold is the only choice that is
--    safe both ways, and it is visible on the voucher with its reason.
--
-- 2. When the transferor keeps another parcel of the same case, the case is
--    now split PARCEL-WISE instead of being left for a manual re-apportion.
--    Case owner shares are case-wide, but every case line (lease area, crops,
--    trees, other items) names its parcel, so the case's value is known per
--    parcel (as api.case_totals values it: lease area × rate × term, plus the
--    line amounts). The transferor's entitlement is split into the part that
--    comes from the transferred parcels (their value × the share the
--    transferor held in each, from the ownership history this mutation
--    wrote) and the part from the parcels they keep (value × their current
--    share). Only the transferred part moves, and of that only what is not
--    yet paid:
--        kept  = max(paid share, case share × kept-parcel part / whole)
--        moved = case share − kept     (split by the heir shares, as in 0061)
--    Payments made to the transferor before the transfer are not attributed
--    to a parcel, so they are counted against the parcels the transferor
--    keeps first; any excess reduces the new owner's portion and is noted.
--    Lines without a parcel (some other items) follow the parcel lines pro
--    rata. When the lines carry no value yet, the parcels' recorded areas
--    weigh instead. With no parcel kept, the result equals 0061's.
--
-- 3. ROW / easement hand-over keeps marking parcels "Leased" (0060): the
--    company holds a right of use and the title stays with the owner, which
--    is what "Leased" records; "Acquired" would claim title and overstate the
--    acquired acreage. The acquisition keeps its mode, so reports can still
--    tell a ROW from a lease. No change here.

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

-- Value of a case's lines on each parcel, and of the lines with no parcel.
CREATE FUNCTION lms.case_parcel_value(p_case uuid)
RETURNS TABLE(survey_id uuid, value numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH c AS (SELECT coalesce(lease_rate, 0) AS rate, coalesce(lease_term_months, 0) AS term
               FROM lms.compensation_case WHERE id = p_case)
  SELECT x.survey_id, sum(x.v) FROM (
    SELECT l.survey_id, c.rate * coalesce(l.subsequent_area, l.lease_area) * c.term / 12.0 AS v
      FROM lms.case_lease_line l, c WHERE l.case_id = p_case
    UNION ALL SELECT survey_id, amount FROM lms.case_crop_line WHERE case_id = p_case
    UNION ALL SELECT survey_id, amount FROM lms.case_tree_line WHERE case_id = p_case
    UNION ALL SELECT survey_id, amount FROM lms.case_misc_line WHERE case_id = p_case
  ) x GROUP BY x.survey_id;
$$;
REVOKE ALL ON FUNCTION lms.case_parcel_value(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.case_parcel_value(uuid) TO lms_readwrite, lms_readonly;   -- caller's rights: row-level security applies

CREATE OR REPLACE FUNCTION lms.mutation_repoint_payments(p_mutation_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor   uuid := util.require_actor();
  m         record;
  c         record;
  l         record;
  h         record;
  v_payable numeric;
  v_paid    numeric;
  v_paidpct numeric;
  v_out     numeric;
  v_keep    numeric;
  v_target  numeric;
  v_kept    numeric;
  v_moved   numeric;
  v_part    numeric;
  v_resid   numeric;
  v_top     uuid;
  v_note    text;
  v_held    integer;
  v_heldamt numeric;
  v_rows    integer := 0;
BEGIN
  SELECT * INTO m FROM lms.mutation WHERE id = p_mutation_id;
  IF NOT FOUND OR m.stage_code <> 'Approved & Applied' THEN
    RAISE EXCEPTION 'payments are re-pointed only for a mutation being applied'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM set_config('lms.mutation_repoint', p_mutation_id::text, true);

  -- ---------- compensation cases ----------
  FOR c IN
    SELECT cc.id, cc.code::text AS code, cc.province_code, co.share_pct::numeric AS share_pct
      FROM lms.compensation_case cc
      JOIN lms.case_owner co ON co.case_id = cc.id AND co.landowner_id = m.transferor_id
     WHERE cc.stage_code NOT IN ('Cancelled', 'Stopped')
       AND EXISTS (
         SELECT 1 FROM lms.mutation_survey ms
          WHERE ms.mutation_id = p_mutation_id
            AND ms.survey_id IN (
              SELECT survey_id FROM lms.case_lease_line WHERE case_id = cc.id
              UNION SELECT survey_id FROM lms.case_crop_line WHERE case_id = cc.id
              UNION SELECT survey_id FROM lms.case_tree_line WHERE case_id = cc.id
              UNION SELECT survey_id FROM lms.case_misc_line WHERE case_id = cc.id))
     ORDER BY cc.code
     FOR UPDATE OF cc
  LOOP
    SELECT coalesce(om.paid_amount, 0) INTO v_paid
      FROM lms.case_owner_money om
     WHERE om.case_id = c.id AND om.landowner_id = m.transferor_id;
    SELECT coalesce(cm.payable_amount, 0) INTO v_payable FROM lms.case_money cm WHERE cm.case_id = c.id;
    v_paid := coalesce(v_paid, 0); v_payable := coalesce(v_payable, 0);

    -- 1. Hold the transferor's unreleased vouchers on this case.
    WITH pending AS (
      SELECT pr.id, pr.gross_amount::numeric AS amt
        FROM lms.payment_request pr
       WHERE pr.landowner_id = m.transferor_id
         AND pr.stage_code IN ('Requested', 'Verified') AND pr.reversed_at IS NULL
         AND (pr.case_id = c.id OR EXISTS (SELECT 1 FROM lms.payment_allocation al
                                            WHERE al.payment_id = pr.id AND al.case_id = c.id))
         AND NOT EXISTS (SELECT 1 FROM lms.payment_hold ph
                          WHERE ph.scope = 'payment' AND ph.payment_id = pr.id AND ph.lifted_at IS NULL)
    ), ins AS (
      INSERT INTO lms.payment_hold (scope, payment_id, reason, placed_by)
      SELECT 'payment', p.id,
             format('Ownership changed by mutation %s (%s): cancel and raise for the new owner, or release if earned before the transfer',
                    m.code, m.mutation_type), v_actor
        FROM pending p RETURNING payment_id
    )
    SELECT count(*), coalesce(sum(p.amt), 0) INTO v_held, v_heldamt FROM pending p;
    v_note := CASE WHEN v_held > 0 THEN format('%s unreleased voucher(s) of the transferor, Rs %s, put on hold for Finance',
                                               v_held, to_char(v_heldamt, 'FM999,999,999,990.00')) END;

    -- 2. Parcel-wise: the part of the transferor's entitlement that comes from
    --    the transferred parcels, and the part from the parcels they keep.
    WITH val AS (SELECT * FROM lms.case_parcel_value(c.id)),
         area AS (SELECT s.id AS survey_id, s.total_area::numeric AS a FROM lms.survey s
                   WHERE s.id IN (SELECT survey_id FROM val WHERE survey_id IS NOT NULL)),
         usev AS (SELECT (SELECT coalesce(sum(value), 0) FROM val WHERE survey_id IS NOT NULL) > 0 AS by_value),
         w AS (SELECT v.survey_id, CASE WHEN (SELECT by_value FROM usev) THEN v.value ELSE a.a END AS weight
                 FROM val v JOIN area a ON a.survey_id = v.survey_id),
         out_share AS (SELECT hist.survey_id, sum(hist.share_pct)::numeric AS pct FROM lms.survey_ownership_history hist
                        WHERE hist.mutation_id = p_mutation_id AND hist.landowner_id = m.transferor_id
                          AND hist.valid_to IS NOT NULL GROUP BY hist.survey_id),
         keep_share AS (SELECT s.survey_id, s.share_pct::numeric AS pct FROM lms.survey_ownership_share s
                         WHERE s.landowner_id = m.transferor_id)
    SELECT coalesce(sum(w.weight * os.pct / 100), 0), coalesce(sum(w.weight * ks.pct / 100), 0)
      INTO v_out, v_keep
      FROM w LEFT JOIN out_share os ON os.survey_id = w.survey_id
             LEFT JOIN keep_share ks ON ks.survey_id = w.survey_id;
    v_out := coalesce(v_out, 0); v_keep := coalesce(v_keep, 0);

    -- Share of the case the transferor keeps for the parcels they keep.
    IF v_out + v_keep <= 0 THEN
      v_target := CASE WHEN v_keep > 0 THEN c.share_pct ELSE 0 END;
    ELSE
      v_target := round(c.share_pct * v_keep / (v_out + v_keep), 4);
    END IF;
    v_paidpct := CASE WHEN v_paid <= 0 THEN 0
                      WHEN v_payable <= 0 THEN c.share_pct
                      ELSE least(c.share_pct, ceil(v_paid * 1000000 / v_payable) / 10000) END;
    v_kept := greatest(v_paidpct, v_target);
    v_moved := c.share_pct - v_kept;
    IF v_target > 0 THEN
      v_note := concat_ws('; ', format('Parcel-wise: the transferor keeps %s%% for the parcels still held', v_target), v_note);
    END IF;
    IF v_paidpct > v_target AND v_target < c.share_pct AND v_out > 0 THEN
      v_note := concat_ws('; ', format('Rs %s paid to the transferor before the transfer exceeds the parcels kept; the new owner''s portion is reduced by it',
                                       to_char(v_paid - (v_target * v_payable / 100), 'FM999,999,999,990.00')), v_note);
    END IF;

    IF v_moved <= 0 THEN
      INSERT INTO lms.mutation_repoint (mutation_id, province_code, kind, record_id, record_code,
             from_landowner_id, to_landowner_id, share_moved, share_kept, paid_amount, note, created_by)
      VALUES (p_mutation_id, c.province_code, 'case', c.id, c.code, m.transferor_id, NULL, 0, v_kept, v_paid,
              concat_ws('; ', CASE WHEN v_target >= c.share_pct THEN 'Nothing of this case comes from the transferred parcels'
                                   ELSE 'Paid in full: nothing to re-point' END, v_note), v_actor);
      v_rows := v_rows + 1;
      CONTINUE;
    END IF;

    IF v_kept > 0 THEN
      UPDATE lms.case_owner SET share_pct = v_kept WHERE case_id = c.id AND landowner_id = m.transferor_id;
    ELSE
      DELETE FROM lms.case_owner WHERE case_id = c.id AND landowner_id = m.transferor_id;
    END IF;

    SELECT v_moved - sum(round(v_moved * mh.share_pct / 100, 4)) INTO v_resid
      FROM lms.mutation_heir mh WHERE mh.mutation_id = p_mutation_id;
    SELECT mh.landowner_id INTO v_top
      FROM lms.mutation_heir mh JOIN lms.landowner lo ON lo.id = mh.landowner_id
     WHERE mh.mutation_id = p_mutation_id ORDER BY mh.share_pct DESC, lo.code LIMIT 1;

    FOR h IN SELECT mh.landowner_id, mh.share_pct FROM lms.mutation_heir mh WHERE mh.mutation_id = p_mutation_id
    LOOP
      v_part := round(v_moved * h.share_pct / 100, 4) + CASE WHEN h.landowner_id = v_top THEN coalesce(v_resid, 0) ELSE 0 END;
      CONTINUE WHEN v_part <= 0;
      INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct)
      VALUES (c.id, h.landowner_id, 'O', v_part)
      ON CONFLICT (case_id, landowner_id) DO UPDATE SET share_pct = lms.case_owner.share_pct + EXCLUDED.share_pct;
      INSERT INTO lms.mutation_repoint (mutation_id, province_code, kind, record_id, record_code,
             from_landowner_id, to_landowner_id, share_moved, share_kept, paid_amount, note, created_by)
      VALUES (p_mutation_id, c.province_code, 'case', c.id, c.code, m.transferor_id, h.landowner_id,
              v_part, v_kept, v_paid, v_note, v_actor);
      v_rows := v_rows + 1;
    END LOOP;
  END LOOP;

  -- ---------- active leases ----------
  FOR l IN
    SELECT le.id, le.code::text AS code, le.province_code
      FROM lms.lease le
      JOIN lms.lease_lessor ll ON ll.lease_id = le.id AND ll.landowner_id = m.transferor_id
     WHERE le.terminated_on IS NULL
       AND (le.end_date IS NULL OR le.end_date >= current_date OR le.auto_extend)
       AND EXISTS (SELECT 1 FROM lms.lease_survey ls
                     JOIN lms.mutation_survey ms ON ms.survey_id = ls.survey_id
                    WHERE ls.lease_id = le.id AND ms.mutation_id = p_mutation_id)
     ORDER BY le.code
     FOR UPDATE OF le
  LOOP
    -- The transferor's unreleased rent vouchers on this lease are held too.
    WITH pending AS (
      SELECT pr.id, pr.gross_amount::numeric AS amt FROM lms.payment_request pr
       WHERE pr.landowner_id = m.transferor_id AND pr.lease_id = l.id
         AND pr.stage_code IN ('Requested', 'Verified') AND pr.reversed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM lms.payment_hold ph
                          WHERE ph.scope = 'payment' AND ph.payment_id = pr.id AND ph.lifted_at IS NULL)
    ), ins AS (
      INSERT INTO lms.payment_hold (scope, payment_id, reason, placed_by)
      SELECT 'payment', p.id,
             format('Ownership changed by mutation %s (%s): cancel and raise for the new lessor, or release if the rent period is before the transfer',
                    m.code, m.mutation_type), v_actor
        FROM pending p RETURNING payment_id
    )
    SELECT count(*), coalesce(sum(p.amt), 0) INTO v_held, v_heldamt FROM pending p;
    v_note := concat_ws('; ', 'Future rent to the new lessor; rent already paid stays on its vouchers',
                        CASE WHEN v_held > 0 THEN format('%s unreleased rent voucher(s), Rs %s, put on hold for Finance',
                                                         v_held, to_char(v_heldamt, 'FM999,999,999,990.00')) END);

    FOR h IN SELECT mh.landowner_id, mh.share_pct FROM lms.mutation_heir mh WHERE mh.mutation_id = p_mutation_id
    LOOP
      INSERT INTO lms.lease_lessor (lease_id, landowner_id) VALUES (l.id, h.landowner_id) ON CONFLICT DO NOTHING;
      INSERT INTO lms.mutation_repoint (mutation_id, province_code, kind, record_id, record_code,
             from_landowner_id, to_landowner_id, share_moved, note, created_by)
      VALUES (p_mutation_id, l.province_code, 'lease', l.id, l.code, m.transferor_id, h.landowner_id,
              h.share_pct, v_note, v_actor);
      v_rows := v_rows + 1;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM lms.survey_ownership_share sos
                     JOIN lms.lease_survey ls ON ls.survey_id = sos.survey_id
                    WHERE ls.lease_id = l.id AND sos.landowner_id = m.transferor_id) THEN
      DELETE FROM lms.lease_lessor WHERE lease_id = l.id AND landowner_id = m.transferor_id;
    END IF;
  END LOOP;

  PERFORM set_config('lms.mutation_repoint', '', true);
  RETURN v_rows;
END $function$;
REVOKE ALL ON FUNCTION lms.mutation_repoint_payments(uuid) FROM PUBLIC;

RESET ROLE;
