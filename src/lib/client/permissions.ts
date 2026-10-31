'use client';

// What the signed-in user may do, for the screens. Permissions are the
// `resource:action` strings /api/auth/me returns (useLMS().permissions). The
// server checks every request again; these helpers only keep the UI from
// offering pages, sections and controls the user could never use, and keep
// it in step when an administrator changes the user's roles.
//
//   useCan()                    → can('cases:approve'), can(['a','b'], 'any')
//   useCanIn()                  → canIn('cases:approve', record.province_code)
//   routePermission(pathname)   → what a page needs (null = any signed-in user)
//   usePermissionRefresh(fn)    → re-read permissions on focus, every 60 s and after a 403
//   onForbidden()               → call when an API answers 403 'forbidden'

import { useCallback, useEffect, useRef } from 'react';
import { useLMS } from '@/components/layout/Shell';
import { routePermissionOf, satisfies, satisfiesIn } from '@/components/layout/nav';
import { clearApiCache } from './api';

export { isForbidden } from './api';
export { satisfies, satisfiesIn } from '@/components/layout/nav';

export type Need = string | string[];
export type Mode = 'all' | 'any';

/** `can(need, mode)` against the signed-in user's permissions; false until they are loaded. */
export function useCan(): (need: Need, mode?: Mode) => boolean {
  const { permissions } = useLMS();
  return useCallback((need: Need, mode: Mode = 'all') => satisfies(permissions, need, mode), [permissions]);
}

/**
 * `canIn(need, province)`: the permission, and the record's province is one of
 * the user's provinces, as the server's ctx.can treats a province-scoped grant.
 * A record without a province is refused (the server no longer lets a
 * province-limited grant act on one); a user with no province list is not
 * narrowed further (their records are those row-level security showed them).
 * /api/auth/me does not say which province each grant covers, so a grant
 * limited to one province is checked by the server only.
 */
export function useCanIn(): (need: Need, province: string | null | undefined, mode?: Mode) => boolean {
  const { permissions, provinces } = useLMS();
  return useCallback((need: Need, province: string | null | undefined, mode: Mode = 'all') =>
    satisfiesIn(permissions, provinces, need, province, mode), [permissions, provinces]);
}

/** What a page needs: every listed permission. null = any signed-in user. Unregistered routes are refused. */
export function routePermission(pathname: string): string[] | null {
  return routePermissionOf(pathname);
}

// ---- keeping the UI in step with the server ---------------------------------

const FORBIDDEN_EVENT = 'lms:forbidden';
const REFRESH_EVERY_MS = 60_000;
const MIN_GAP_MS = 2_000;          // focus + visibilitychange + a burst of 403s → one refresh

/** Tell the shell that the server refused something: it re-reads the user's permissions. */
export function onForbidden(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FORBIDDEN_EVENT));
}

/**
 * Re-read the user's permissions (via `refresh`, e.g. the Shell's /api/auth/me
 * loader) when the window regains focus, every 60 s while visible, and after
 * onForbidden(). Also clears the useApi cache when the permission set changes
 * (see usePermissionCacheReset, which needs the LMS context; the Shell renders
 * PageGuard inside its provider, and PageGuard does the reset).
 */
export function usePermissionRefresh(refresh: () => Promise<void> | void): void {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);

  useEffect(() => {
    let last = Date.now();         // the shell has just loaded the user
    let inFlight = false;
    const run = () => {
      const now = Date.now();
      if (inFlight || now - last < MIN_GAP_MS) return;
      last = now; inFlight = true;
      Promise.resolve().then(() => latest.current()).catch(() => { /* the next trigger retries */ })
        .finally(() => { inFlight = false; });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') run(); }, REFRESH_EVERY_MS);
    window.addEventListener('focus', run);
    window.addEventListener(FORBIDDEN_EVENT, run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', run);
      window.removeEventListener(FORBIDDEN_EVENT, run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  usePermissionCacheReset();
}

// The last permission set seen in this tab. Module scope on purpose: every page
// mounts its own Shell, so a change between two pages must be noticed too.
let lastKey: string | null = null;

/** Clears the useApi cache when the user, their permissions or their provinces change. */
export function usePermissionCacheReset(): void {
  const { currentUser, permissions, provinces } = useLMS();
  const key = currentUser ? `${currentUser.id}|${[...permissions].sort().join(',')}|${[...provinces].sort().join(',')}` : null;
  useEffect(() => {
    if (key === null) return;      // not loaded yet (or outside the provider)
    if (lastKey !== null && lastKey !== key) clearApiCache();
    lastKey = key;
  }, [key]);
}
