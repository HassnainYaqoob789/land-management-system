import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireEnv } from './config';

// ---- tokens ---------------------------------------------------------------
/** 256 bits from the OS CSPRNG, URL-safe. The raw value goes to the client;
 * only sha256(raw) is ever stored. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- keyed MAC (CSRF tokens, recovery-code verifiers) ----------------------
function hmacKey(): Buffer {
  const k = Buffer.from(requireEnv('IAM_HMAC_KEY'), 'base64');
  if (k.length < 32) throw new Error('IAM_HMAC_KEY must be at least 32 bytes (base64)');
  return k;
}
export function hmac(label: string, value: string): Buffer {
  // The label domain-separates uses, so a CSRF MAC can never be replayed as a
  // recovery-code verifier.
  return createHmac('sha256', hmacKey()).update(label).update('\0').update(value).digest();
}

// ---- authenticated encryption for stored secrets ---------------------------
// AES-256-GCM. Layout: 0x01 | nonce(12) | ciphertext | tag(16). The secret's
// name is bound as associated data, so a ciphertext copied to another row
// fails authentication instead of decrypting.
type Keyring = { active: string; keys: Map<string, Buffer> };
let ring: Keyring | undefined;

export function keyring(): Keyring {
  if (ring) return ring;
  const raw = requireEnv('IAM_MASTER_KEYS'); // "id:base64,id2:base64"
  const keys = new Map<string, Buffer>();
  let active = '';
  for (const part of raw.split(',')) {
    const i = part.indexOf(':');
    const id = part.slice(0, i).trim();
    const key = Buffer.from(part.slice(i + 1).trim(), 'base64');
    if (!id || key.length !== 32) throw new Error('IAM_MASTER_KEYS entries must be id:base64(32 bytes)');
    keys.set(id, key);
    if (!active) active = id; // the first key encrypts; the rest only decrypt (rotation)
  }
  if (!active) throw new Error('IAM_MASTER_KEYS is empty');
  return (ring = { active, keys });
}
export function resetKeyringForTests() { ring = undefined; }

export function encrypt(plaintext: string, aad: string): { keyId: string; blob: Buffer } {
  const { active, keys } = keyring();
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys.get(active)!, nonce);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { keyId: active, blob: Buffer.concat([Buffer.from([1]), nonce, ct, c.getAuthTag()]) };
}

export function decrypt(blob: Buffer, keyId: string, aad: string): string {
  const key = keyring().keys.get(keyId);
  if (!key) throw new Error(`encryption key "${keyId}" is not in the keyring`);
  if (blob[0] !== 1 || blob.length < 29) throw new Error('unrecognised ciphertext');
  const nonce = blob.subarray(1, 13), tag = blob.subarray(blob.length - 16), ct = blob.subarray(13, blob.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---- recovery codes --------------------------------------------------------
/** 10 codes of 80 bits, grouped for typing. */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const h = randomBytes(10).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5, 10)}-${h.slice(10, 15)}-${h.slice(15, 20)}`;
  });
}
export function recoveryVerifier(code: string): Buffer {
  return hmac('recovery', code.toLowerCase().replace(/[^0-9a-f]/g, ''));
}
