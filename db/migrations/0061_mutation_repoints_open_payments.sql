-- =====================================================================
-- 0061  An applied mutation re-points open compensation and lease rent
-- =====================================================================
-- Client requirement (2026-11-02): "The owner sold the land (or died).
-- Future payments must go to the new owner. The field initiates it, then
-- approvals." The mutation workflow (Initiated -> Revenue Verified -> Legal
-- Cleared -> Approved & Applied) already exists; api.advance_workflow calls
-- api.apply_mutation at the last stage, which moved only the parcel shares
-- (lms.survey_ownership_share). Open compensation cases (lms.case_owner) and
-- leases (lms.lease_lessor) kept pointing at the transferor, and a deceased
-- transferor cannot be paid at all (0059), so the money was stuck.
--
-- What api.apply_mutation now also does, in the same transaction, after the
-- parcel shares have moved (its signature and return value are unchanged):
--
-- 1. Compensation cases. A case is OPEN when its stage is not Cancelled
--    (cases have no Closed / Paid stage: HO Approved is the stage payments
--    are made from, so an HO Approved case with an unpaid balance is the
--    normal open case). It is re-pointed when
--      * it covers one of the mutation's parcels (any lease, crop, tree or
--        miscellaneous line on lms.mutation_survey), and
--      * the transferor is one of its owners, and
--      * after the transfer the transferor holds no share in ANY parcel of
--        the case. Case shares are case-wide, not per parcel, so when the
--        transferor keeps another parcel of the case there is no defensible
--        automatic split; the case is left unchanged and a 'skipped' row is
--        written so the officer sends the case back and re-apportions it.
--    The transferor keeps the part of the case share already PAID (released
--    and not reversed: lms.case_owner_money.paid_amount, the figure the
--    receipts and api.rpt_case_owner use):
--        kept = ceil4( paid / case payable * 100 ), at most the share held.
--    It is rounded UP to the 4 dp of the share domain so the transferor's
--    attributed payable never falls below what was already paid (no false
--    "Overpaid"); the heirs lose at most 0.0001% of the case to this.
--    The rest (moved = share - kept) goes to the heirs/buyers in proportion
--    to lms.mutation_heir.share_pct, each rounded to 4 dp; the rounding
--    residue (a few 0.0001%) goes to the heir with the largest portion (ties:
--    lowest landowner code), so the case still totals exactly 100.0000%.
--    An heir already on the case has the portion added to their row (their
--    owner_status is kept); a new heir is added as owner 'O'. A transferor
--    with nothing paid is removed from the case. A transferor already paid
--    in full keeps the share; a row records that nothing moved.
-- 2. Leases. A lease is ACTIVE when it is not terminated and not expired
--    (end_date today or later, no end date, or auto_extend). A lease that
--    covers a mutation parcel and lists the transferor as lessor gets every
--    heir/buyer as lessor (lease_lessor has no share column; rent per lessor
--    is decided on the voucher). The transferor is removed as lessor when
--    they no longer hold a share in any parcel of the lease. Rent already
--    paid stays on its vouchers; only future vouchers are affected.
-- 3. Every moved share (and every skip) is written to the new append-only
--    lms.mutation_repoint, read by the app through api.v_mutation_repoint.
--
-- Guard bypass, and why this one:
--   case_owner is protected by tg_terms_frozen (bypassed for any lms_owner
--   context, as before) and tg_case_child_locked, which refuses every change
--   at HO Approved, even the owner's. tg_case_child_locked now lets a change
--   through ONLY when all of these hold:
--     a. the table is case_owner (lines and other children stay locked);
--     b. current_user is a member of lms_owner, i.e. the statement runs
--        inside a SECURITY DEFINER routine owned by lms_owner (lms_app is not
--        a member; assertSafeDbRole refuses an owner connection);
--     c. the transaction-local setting lms.mutation_repoint holds the id of a
--        mutation that is at 'Approved & Applied'. Only
--        lms.mutation_repoint_payments sets it (set_config(..., true)) and it
--        clears it before returning.
--   lms_app can set (c) itself but can never satisfy (b); and other definer
--   routines satisfy (b) but never set (c). A session_user test was rejected
--   because migrations and seeds also run as an owner member.
--   lms.mutation_repoint_payments is not SECURITY DEFINER and is executable
--   only by its owner, so it runs only from api.apply_mutation.
--
-- Audit: case_owner changes are logged by audit.tg_audit_row with the actor
-- of the transaction, i.e. the approver who applied the mutation (the actor
-- is set by api.set_actor before advance_workflow). lease_lessor has no audit
-- trigger; lms.mutation_repoint (audited too) is the record for leases.
--
-- Not changed: vouchers already raised for the transferor and not yet
-- released. The kept share counts only released money; such vouchers are
-- reported in the 'note' of the repoint row so Finance can cancel them.
-- Unattributed payments on a multi-owner case (allocation with no
-- landowner) are not counted as the transferor's.

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

-- ---------------------------------------------------------------------
-- 1. The record of what moved
-- ---------------------------------------------------------------------
CREATE TABLE lms.mutation_repoint (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mutation_id        uuid NOT NULL REFERENCES lms.mutation(id) ON DELETE RESTRICT,
  province_code      character(3) NOT NULL REFERENCES lms.province(code),
  kind               text NOT NULL CHECK (kind IN ('case', 'lease')),
  record_id          uuid NOT NULL,
  record_code        text NOT NULL,
  from_landowner_id  uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  to_landowner_id    uuid REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  -- case: percent of the case moved to this heir; lease: the heir's percent
  -- of the transferor's interest (mutation_heir.share_pct).
  share_moved        numeric(7,4) NOT NULL CHECK (share_moved >= 0 AND share_moved <= 100),
  -- case: the share the transferor keeps for what was already paid.
  share_kept         numeric(7,4) CHECK (share_kept >= 0 AND share_kept <= 100),
  paid_amount        numeric(18,2) CHECK (paid_amount >= 0),
  note               text,
  created_by         uuid REFERENCES lms.app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (to_landowner_id IS NOT NULL OR share_moved = 0)
);
CREATE INDEX mutation_repoint_mutation_ix ON lms.mutation_repoint (mutation_id);
CREATE INDEX mutation_repoint_record_ix ON lms.mutation_repoint (kind, record_id);
CREATE INDEX mutation_repoint_province_ix ON lms.mutation_repoint (province_code);
ALTER TABLE lms.mutation_repoint OWNER TO lms_owner;

-- Append-only, for everyone (the owner included).
CREATE FUNCTION lms.tg_mutation_repoint_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'payment re-pointing records cannot be changed or removed'
    USING ERRCODE = 'insufficient_privilege';
END $function$;
REVOKE ALL ON FUNCTION lms.tg_mutation_repoint_append_only() FROM PUBLIC;
CREATE TRIGGER mutation_repoint_append_only BEFORE UPDATE OR DELETE ON lms.mutation_repoint
  FOR EACH ROW EXECUTE FUNCTION lms.tg_mutation_repoint_append_only();
CREATE TRIGGER mutation_repoint_audit AFTER INSERT OR UPDATE OR DELETE ON lms.mutation_repoint
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

ALTER TABLE lms.mutation_repoint ENABLE ROW LEVEL SECURITY;
CREATE POLICY province_scope ON lms.mutation_repoint FOR ALL TO lms_readwrite, lms_readonly
  USING      ((SELECT lms.actor_role()) = 'Admin' OR province_code = ANY ((SELECT lms.actor_provinces())::bpchar[]))
  WITH CHECK ((SELECT lms.actor_role()) = 'Admin' OR province_code = ANY ((SELECT lms.actor_provinces())::bpchar[]));

-- Written only by the mutation routine (as the owner); the application reads.
GRANT SELECT ON lms.mutation_repoint TO lms_readwrite, lms_readonly;

-- ---------------------------------------------------------------------
-- 2. The read view
-- ---------------------------------------------------------------------
CREATE VIEW api.v_mutation_repoint WITH (security_invoker = true) AS
SELECT r.id, r.mutation_id, m.code AS mutation_code, r.province_code, r.kind,
       r.record_id, r.record_code,
       r.from_landowner_id, f.code AS from_code, f.full_name AS from_name,
       r.to_landowner_id, t.code AS to_code, t.full_name AS to_name,
       r.share_moved, r.share_kept, r.paid_amount, r.note, r.created_at,
       lms.user_full_name(r.created_by) AS created_by_name
  FROM lms.mutation_repoint r
  JOIN lms.mutation m ON m.id = r.mutation_id
  JOIN lms.landowner f ON f.id = r.from_landowner_id
  LEFT JOIN lms.landowner t ON t.id = r.to_landowner_id;
ALTER VIEW api.v_mutation_repoint OWNER TO lms_owner;
GRANT SELECT ON api.v_mutation_repoint TO lms_readwrite, lms_readonly;

-- ---------------------------------------------------------------------
-- 3. The guard: case owners of an HO Approved case change only here
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.tg_case_child_locked()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v record; v_flag text;
BEGIN
  SELECT code, stage_code INTO v FROM lms.compensation_case
  WHERE id = coalesce(NEW.case_id, OLD.case_id);
  -- No parent: the parent is being deleted and is cascading to us.
  IF NOT FOUND THEN RETURN coalesce(NEW, OLD); END IF;
  IF v.stage_code IN ('HO Approved','Cancelled') THEN
    -- 0061: an applied mutation re-points the owners of an open case. Only
    -- inside a definer routine owned by lms_owner AND with the flag that
    -- lms.mutation_repoint_payments sets for a mutation being applied.
    v_flag := coalesce(current_setting('lms.mutation_repoint', true), '');
    IF TG_TABLE_NAME = 'case_owner' AND v.stage_code = 'HO Approved'
       AND v_flag ~ '^[0-9a-f-]{36}$'
       AND pg_has_role(current_user, 'lms_owner', 'MEMBER')
       AND EXISTS (SELECT 1 FROM lms.mutation m
                    WHERE m.id = v_flag::uuid AND m.stage_code = 'Approved & Applied') THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    RAISE EXCEPTION 'case % is % and its % rows cannot be changed', v.code, v.stage_code, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(NEW, OLD);
END $function$;
REVOKE ALL ON FUNCTION lms.tg_case_child_locked() FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 4. The re-pointing
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.mutation_repoint_payments(p_mutation_id uuid)
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
  v_live    numeric;
  v_kept    numeric;
  v_moved   numeric;
  v_part    numeric;
  v_resid   numeric;
  v_top     uuid;
  v_note    text;
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
    SELECT coalesce(om.paid_amount, 0), coalesce(om.allocated_amount, 0)
      INTO v_paid, v_live
      FROM lms.case_owner_money om
     WHERE om.case_id = c.id AND om.landowner_id = m.transferor_id;
    SELECT coalesce(cm.payable_amount, 0) INTO v_payable
      FROM lms.case_money cm WHERE cm.case_id = c.id;
    v_paid := coalesce(v_paid, 0); v_live := coalesce(v_live, 0); v_payable := coalesce(v_payable, 0);
    v_note := CASE WHEN v_live > v_paid
                   THEN format('Rs %s of vouchers for the transferor not yet released; review them',
                               to_char(v_live - v_paid, 'FM999,999,999,990.00')) END;

    -- Case shares are case-wide: re-point only when the transferor no longer
    -- holds any parcel of the case.
    IF EXISTS (
      SELECT 1 FROM lms.survey_ownership_share sos
       WHERE sos.landowner_id = m.transferor_id
         AND sos.survey_id IN (
           SELECT survey_id FROM lms.case_lease_line WHERE case_id = c.id
           UNION SELECT survey_id FROM lms.case_crop_line WHERE case_id = c.id
           UNION SELECT survey_id FROM lms.case_tree_line WHERE case_id = c.id
           UNION SELECT survey_id FROM lms.case_misc_line WHERE case_id = c.id)) THEN
      INSERT INTO lms.mutation_repoint (mutation_id, province_code, kind, record_id, record_code,
             from_landowner_id, to_landowner_id, share_moved, share_kept, paid_amount, note, created_by)
      VALUES (p_mutation_id, c.province_code, 'case', c.id, c.code, m.transferor_id, NULL, 0,
              c.share_pct, v_paid,
              concat_ws('; ', 'Not re-pointed: the transferor still holds other parcels of this case. '
                              'Send the case back and re-apportion the owners', v_note),
              v_actor);
      v_rows := v_rows + 1;
      CONTINUE;
    END IF;

    IF v_paid <= 0 THEN
      v_kept := 0;
    ELSIF v_payable <= 0 THEN
      v_kept := c.share_pct;
    ELSE
      v_kept := least(c.share_pct, ceil(v_paid * 1000000 / v_payable) / 10000);
    END IF;
    v_moved := c.share_pct - v_kept;

    IF v_moved <= 0 THEN
      INSERT INTO lms.mutation_repoint (mutation_id, province_code, kind, record_id, record_code,
             from_landowner_id, to_landowner_id, share_moved, share_kept, paid_amount, note, created_by)
      VALUES (p_mutation_id, c.province_code, 'case', c.id, c.code, m.transferor_id, NULL, 0,
              v_kept, v_paid, concat_ws('; ', 'Paid in full: nothing to re-point', v_note), v_actor);
      v_rows := v_rows + 1;
      CONTINUE;
    END IF;

    -- The transferor keeps the paid part, or leaves the case.
    IF v_kept > 0 THEN
      UPDATE lms.case_owner SET share_pct = v_kept
       WHERE case_id = c.id AND landowner_id = m.transferor_id;
    ELSE
      DELETE FROM lms.case_owner WHERE case_id = c.id AND landowner_id = m.transferor_id;
    END IF;

    -- Heir portions, 4 dp; the residue goes to the largest portion.
    SELECT v_moved - sum(round(v_moved * mh.share_pct / 100, 4)) INTO v_resid
      FROM lms.mutation_heir mh WHERE mh.mutation_id = p_mutation_id;
    SELECT mh.landowner_id INTO v_top
      FROM lms.mutation_heir mh JOIN lms.landowner lo ON lo.id = mh.landowner_id
     WHERE mh.mutation_id = p_mutation_id
     ORDER BY mh.share_pct DESC, lo.code
     LIMIT 1;

    FOR h IN SELECT mh.landowner_id, mh.share_pct FROM lms.mutation_heir mh
              WHERE mh.mutation_id = p_mutation_id
    LOOP
      v_part := round(v_moved * h.share_pct / 100, 4)
                + CASE WHEN h.landowner_id = v_top THEN coalesce(v_resid, 0) ELSE 0 END;
      CONTINUE WHEN v_part <= 0;
      INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct)
      VALUES (c.id, h.landowner_id, 'O', v_part)
      ON CONFLICT (case_id, landowner_id) DO UPDATE
        SET share_pct = lms.case_owner.share_pct + EXCLUDED.share_pct;

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
    FOR h IN SELECT mh.landowner_id, mh.share_pct FROM lms.mutation_heir mh
              WHERE mh.mutation_id = p_mutation_id
    LOOP
      INSERT INTO lms.lease_lessor (lease_id, landowner_id)
      VALUES (l.id, h.landowner_id) ON CONFLICT DO NOTHING;
      INSERT INTO lms.mutation_repoint (mutation_id, province_code, kind, record_id, record_code,
             from_landowner_id, to_landowner_id, share_moved, note, created_by)
      VALUES (p_mutation_id, l.province_code, 'lease', l.id, l.code, m.transferor_id, h.landowner_id,
              h.share_pct, 'Future rent to the new lessor; rent already paid stays on its vouchers', v_actor);
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
ALTER FUNCTION lms.mutation_repoint_payments(uuid) OWNER TO lms_owner;
REVOKE ALL ON FUNCTION lms.mutation_repoint_payments(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 5. api.apply_mutation: unchanged, plus the call at the end
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.apply_mutation(p_mutation_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := util.require_actor();
  m       record;
  s       record;
  h       record;
  v_src   numeric;
  v_moved integer := 0;
BEGIN
  SELECT * INTO m FROM lms.mutation WHERE id = p_mutation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such mutation %', p_mutation_id USING ERRCODE = 'no_data_found';
  END IF;

  FOR s IN SELECT ms.survey_id FROM lms.mutation_survey ms WHERE ms.mutation_id = p_mutation_id
  LOOP
    -- The transferor's share of this parcel is what gets divided.
    SELECT share_pct INTO v_src
    FROM lms.survey_ownership_share
    WHERE survey_id = s.survey_id AND landowner_id = m.transferor_id
    FOR UPDATE;
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'the transferor holds no share of parcel % to transfer', s.survey_id
        USING ERRCODE = 'raise_exception';
    END IF;

    INSERT INTO lms.survey_ownership_history
      (survey_id, landowner_id, share_pct, valid_from, valid_to, change_reason,
       mutation_id, recorded_by)
    VALUES (s.survey_id, m.transferor_id, v_src,
            coalesce(m.mutation_date, current_date), coalesce(m.mutation_date, current_date),
            m.mutation_type || ' — transferred out', p_mutation_id, v_actor);

    DELETE FROM lms.survey_ownership_share
    WHERE survey_id = s.survey_id AND landowner_id = m.transferor_id;

    FOR h IN SELECT landowner_id, share_pct FROM lms.mutation_heir WHERE mutation_id = p_mutation_id
    LOOP
      -- Heir shares are a percentage of the transferor's share, not of the
      -- parcel, so they are scaled. Rounded to 4 dp, the precision of the
      -- share domain; the residue is documented in the engineering report.
      INSERT INTO lms.survey_ownership_share
        (survey_id, landowner_id, share_pct, revenue_doc_ref, effective_from, created_by, updated_by)
      VALUES (s.survey_id, h.landowner_id, round(v_src * h.share_pct / 100, 4),
              m.revenue_mutation_no, coalesce(m.mutation_date, current_date), v_actor, v_actor)
      ON CONFLICT (survey_id, landowner_id) DO UPDATE
        SET share_pct = lms.survey_ownership_share.share_pct
                        + round(v_src * h.share_pct / 100, 4),
            updated_by = v_actor, updated_at = clock_timestamp();

      INSERT INTO lms.survey_ownership_history
        (survey_id, landowner_id, share_pct, valid_from, change_reason, mutation_id, recorded_by)
      VALUES (s.survey_id, h.landowner_id, round(v_src * h.share_pct / 100, 4),
              coalesce(m.mutation_date, current_date),
              m.mutation_type || ' — received', p_mutation_id, v_actor);
      v_moved := v_moved + 1;
    END LOOP;
  END LOOP;

  -- An inheritance marks the transferor deceased; a sale leaves their record
  -- active, because they may still own other parcels.
  IF m.mutation_type = 'Inheritance (Virasat)' THEN
    UPDATE lms.landowner SET status = 'Deceased', updated_by = v_actor
    WHERE id = m.transferor_id AND status <> 'Deceased';
  END IF;

  -- 0061: unpaid compensation and future lease rent follow the land.
  PERFORM lms.mutation_repoint_payments(p_mutation_id);

  RETURN v_moved;
END $function$;
REVOKE ALL ON FUNCTION api.apply_mutation(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 6. Self-check
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF has_function_privilege('lms_app', 'lms.mutation_repoint_payments(uuid)', 'EXECUTE')
     OR has_function_privilege('lms_app', 'api.apply_mutation(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0061: the application must not run the re-pointing directly';
  END IF;
  IF has_table_privilege('lms_app', 'lms.mutation_repoint', 'INSERT')
     OR has_table_privilege('lms_app', 'lms.mutation_repoint', 'UPDATE') THEN
    RAISE EXCEPTION '0061: lms.mutation_repoint is written only by the mutation routine';
  END IF;
END $$;

RESET ROLE;
