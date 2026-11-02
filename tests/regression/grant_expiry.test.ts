import { describe, it, expect } from 'vitest';
import { expiryState, expiryBadge, untilLabel, dateInputValue, WARN_DAYS } from '../../src/app/users/grantExpiry';

// How a role grant's end date ("valid until") is labelled on Users & Roles.
// Pure: runs without a server or database.
const NOW = Date.parse('2026-11-02T10:00:00Z');
const DAY = 86_400_000;

describe('role grant end date', () => {
  it('has no end date when expires_at is empty', () => {
    for (const v of [null, undefined, '']) expect(expiryState(v, NOW)).toEqual({ tone: 'none', daysLeft: null, at: null });
    expect(expiryState('not a date', NOW).tone).toBe('none');
    expect(expiryBadge(expiryState(null, NOW))).toBeNull();
  });

  it('is running, without a badge, more than a week out', () => {
    const s = expiryState(new Date(NOW + 30 * DAY).toISOString(), NOW);
    expect(s.tone).toBe('ok');
    expect(s.daysLeft).toBe(30);
    expect(expiryBadge(s)).toBeNull();
  });

  it(`warns within ${WARN_DAYS} days`, () => {
    expect(expiryState(new Date(NOW + WARN_DAYS * DAY).toISOString(), NOW).tone).toBe('soon');
    expect(expiryState(new Date(NOW + WARN_DAYS * DAY + 1000).toISOString(), NOW).tone).toBe('ok');
    expect(expiryBadge(expiryState(new Date(NOW + 3 * DAY).toISOString(), NOW))).toBe('ends in 3 days');
    expect(expiryBadge(expiryState(new Date(NOW + 3600_000).toISOString(), NOW))).toBe('ends within a day');
  });

  it('is expired once the moment has passed', () => {
    const s = expiryState(new Date(NOW - 1).toISOString(), NOW);
    expect(s.tone).toBe('expired');
    expect(expiryBadge(s)).toBe('Expired');
    expect(expiryState(new Date(NOW).toISOString(), NOW).tone).toBe('expired');
  });

  it('labels the date and fills a date input with the local calendar day', () => {
    const at = new Date(2026, 11, 2, 23, 59, 59);   // local end of 2 Dec 2026
    expect(untilLabel(at)).toBe('until 2 Dec 2026');
    expect(dateInputValue(at.toISOString())).toBe('2026-12-02');
    expect(dateInputValue(null)).toBe('');
    expect(dateInputValue('nonsense')).toBe('');
  });
});
