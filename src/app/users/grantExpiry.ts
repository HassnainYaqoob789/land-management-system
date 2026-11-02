// How a role grant's end date ("valid until", iam.user_role.expires_at) is shown:
// none, running, ending within WARN_DAYS (warning tone) or expired. The database
// decides access (iam.effective_permissions ignores a grant once expires_at has
// passed); this only labels it. Pure, so it is unit-tested.

export const WARN_DAYS = 7;
const DAY = 86_400_000;

export type ExpiryTone = 'none' | 'ok' | 'soon' | 'expired';
export interface ExpiryState { tone: ExpiryTone; daysLeft: number | null; at: Date | null }

export function expiryState(expiresAt: string | Date | null | undefined, now: number = Date.now()): ExpiryState {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return { tone: 'none', daysLeft: null, at: null };
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return { tone: 'none', daysLeft: null, at: null };
  const ms = at.getTime() - now;
  if (ms <= 0) return { tone: 'expired', daysLeft: 0, at };
  const daysLeft = Math.ceil(ms / DAY);
  return { tone: daysLeft <= WARN_DAYS ? 'soon' : 'ok', daysLeft, at };
}

/** "until 2 Dec 2026", in the browser's time zone. */
export function untilLabel(at: Date): string {
  return `until ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** The badge text for a grant that has ended or is about to. */
export function expiryBadge(s: ExpiryState): string | null {
  if (s.tone === 'expired') return 'Expired';
  if (s.tone === 'soon') return s.daysLeft === 1 ? 'ends within a day' : `ends in ${s.daysLeft} days`;
  return null;
}

/** A stored end date as the value of an <input type="date"> (local calendar day). */
export function dateInputValue(expiresAt: string | null | undefined): string {
  if (!expiresAt) return '';
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
