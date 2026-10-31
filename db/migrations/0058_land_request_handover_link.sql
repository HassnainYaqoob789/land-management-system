-- =====================================================================
-- 0058  Land request → the record the land team created from it
-- =====================================================================
-- 0057 records the hand-over (who, when, which kind of land work). This links
-- the request to the record then created from it (an acquisition today), so
-- each can be reached from the other. Set once, by the acquisition API in the
-- same transaction that creates the acquisition.

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

ALTER TABLE lms.land_request
  ADD COLUMN handed_over_record_id   uuid,
  ADD COLUMN handed_over_record_code text;

ALTER TABLE lms.acquisition
  ADD COLUMN land_request_id uuid REFERENCES lms.land_request(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX acquisition_land_request_ux ON lms.acquisition (land_request_id) WHERE land_request_id IS NOT NULL;

RESET ROLE;
