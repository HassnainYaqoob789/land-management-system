-- =====================================================================
-- 0063  Raise the document size limit to 100 MB (was 50 MB)
-- =====================================================================
-- lms.document.size_bytes had an inline CHECK of <= 52428800 (50 MB,
-- migration 0008). The application now accepts up to 100 MB (every upload is
-- gzip-compressed at rest and passes a content-safety / malware scan first,
-- src/lib/documents.ts). This replaces the CHECK with a 100 MB limit.
-- The old constraint is dropped by whatever name it carries.

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'lms.document'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%size_bytes%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lms.document DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE lms.document
  ADD CONSTRAINT document_size_bytes_check
  CHECK (size_bytes > 0 AND size_bytes <= 104857600);   -- 100 MB
