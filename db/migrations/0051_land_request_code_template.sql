-- =====================================================================
-- 0051  Register the REQ-YYYY- code template for land requests
-- =====================================================================
-- POST /api/requests numbers a land request with lms.next_code_year('REQ'),
-- which needs a 'REQ-YYYY-' template row in lms.code_sequence. No migration
-- ever registered it: lms_dev had it only because it was added by hand, so on
-- every database built from the migrations (test, demo, production) raising a
-- land request failed with "no year-code template registered for stem REQ".
-- Found by tests/regression/api_authorization.test.ts on 2026-10-30.
-- Template rows carry no sequence of their own (see 0015); next_code_year()
-- creates each year's sequence on first use. Idempotent.

SET ROLE lms_owner;

INSERT INTO lms.code_sequence (prefix, seq_name, pad_to, note)
VALUES ('REQ-YYYY-', 'request_code_template', 4, 'Land request (per year)')
ON CONFLICT (prefix) DO NOTHING;

RESET ROLE;
