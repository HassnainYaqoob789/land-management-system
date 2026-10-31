// Document bytes live outside the database (docs/SECURITY_FINDINGS.md DB-08):
// in a content-addressed store on disk, named by the SHA-256 of the bytes
// themselves. The database row carries that hash, so every read can prove the
// file is the one that was uploaded.
//
// DOCUMENT_STORE_DIR sets where the store is. Production must set it (a volume
// that is backed up and encrypted at rest); development falls back to
// ./.data/documents, which is git-ignored.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { isProd } from '@/lib/iam/config';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;   // lms.document size_bytes CHECK

/** Entities a document may belong to, and the table that holds them. */
export const DOCUMENT_ENTITIES: Record<string, string> = {
  project: 'project', survey: 'survey', landowner: 'landowner', compensation_case: 'compensation_case',
  lease: 'lease', row_corridor: 'row_corridor', acquisition: 'acquisition', legal_case: 'legal_case',
  mutation: 'mutation', encroachment: 'encroachment', grievance: 'grievance', payment_request: 'payment_request',
  dbpfc_estimate: 'dbpfc_estimate',
};

/** The module permission that governs the record a document belongs to (UI-09). */
export const DOCUMENT_RESOURCE: Record<string, string> = {
  project: 'projects', survey: 'surveys', landowner: 'landowners', compensation_case: 'cases',
  lease: 'leases', row_corridor: 'rows', acquisition: 'acquisitions', legal_case: 'legal',
  mutation: 'mutations', encroachment: 'encroachments', grievance: 'grievances', payment_request: 'payments',
  dbpfc_estimate: 'dbpfc',
};

export function storeRoot(): string {
  const dir = process.env.DOCUMENT_STORE_DIR;
  if (dir) return path.resolve(dir);
  if (isProd) throw new Error('DOCUMENT_STORE_DIR must be set in production');
  return path.resolve(process.cwd(), '.data', 'documents');
}

/**
 * The real type of a file from its first bytes. The browser's claim is not
 * trusted: a renamed executable must not be stored as "application/pdf".
 * Office files are ZIP containers, told apart by the name the user gave.
 */
export function sniffMime(bytes: Uint8Array, fileName: string): string | null {
  const b = (i: number) => bytes[i];
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf';            // %PDF
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2a && b(3) === 0x00) ||
      (b(0) === 0x4d && b(1) === 0x4d && b(2) === 0x00 && b(3) === 0x2a)) return 'image/tiff';
  if (b(0) === 0x50 && b(1) === 0x4b && b(2) === 0x03 && b(3) === 0x04) {
    const ext = fileName.toLowerCase().split('.').pop();
    if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return null;
}

/** A file name safe to keep and to send back in Content-Disposition. */
export function cleanFileName(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').trim();
  return base.slice(0, 200) || 'document';
}

const refFor = (hex: string) => `sha256:${hex}`;
const pathFor = (hex: string) => path.join(storeRoot(), hex.slice(0, 2), hex);

/** Store bytes; returns their hash and storage reference. Idempotent for identical bytes. */
export async function storeBytes(bytes: Uint8Array): Promise<{ sha256: Buffer; ref: string }> {
  const sha256 = createHash('sha256').update(bytes).digest();
  const hex = sha256.toString('hex');
  const final = pathFor(hex);
  try { await stat(final); } catch {
    await mkdir(path.dirname(final), { recursive: true, mode: 0o700 });
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, final);   // atomic: a reader never sees a half-written file
  }
  return { sha256, ref: refFor(hex) };
}

export class IntegrityError extends Error {}

/** Read stored bytes, refusing them if they no longer match the recorded hash. */
export async function readVerified(ref: string, expected: Buffer): Promise<Buffer> {
  const m = /^sha256:([0-9a-f]{64})$/.exec(ref);
  if (!m) throw new IntegrityError('This document has no stored file.');
  const bytes = await readFile(pathFor(m[1])).catch(() => { throw new IntegrityError('The stored file is missing.'); });
  const actual = createHash('sha256').update(bytes).digest();
  if (!actual.equals(expected)) throw new IntegrityError('The stored file does not match its recorded checksum.');
  return bytes;
}
