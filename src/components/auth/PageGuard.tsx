'use client';

// Route-level guard (UI-08). The Shell wraps every page's content in it: when
// the user lacks what the route needs (routePermission), the page does not
// mount at all — no form, no list, no API call — and a clear "no access" panel
// is shown instead of an empty or misleading screen. The server still refuses
// every request on its own; this is about not offering what cannot be used.

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLMS } from '@/components/layout/Shell';
import { NAV, UNREGISTERED_ROUTE, routePermissionOf, satisfies } from '@/components/layout/nav';
import { Card, ErrorNote } from '@/components/legacy/ui';
import { isForbidden, useCan, usePermissionCacheReset } from '@/lib/client/permissions';

// What the server says on a 403 'forbidden' (src/lib/iam/http.ts). Used only when
// the caller cannot pass the status (useList returns the message alone).
const FORBIDDEN_MESSAGE = 'You do not have permission to do that.';

/** True when a load failed because the user may not read it. */
export function refused(e: { error?: string; status?: number; code?: string }): boolean {
  return !!e.error && (isForbidden(e) || (e.status === undefined && e.error === FORBIDDEN_MESSAGE));
}

/**
 * The error strip for a screen's data: the no-access panel for a refusal, the
 * server's message otherwise. Callers also skip their "no records" text when
 * there is an error, so a refusal never looks like an empty register.
 */
export function LoadError({ error, status, code, what = 'this information' }: {
  error?: string; status?: number; code?: string; what?: string;
}) {
  if (!error) return null;
  if (refused({ error, status, code })) return <NoAccess what={what} link={false} />;
  return <ErrorNote>{error}</ErrorNote>;
}

/** The first menu page this user can open (Account & Security needs nothing). */
function homeFor(held: readonly string[]): { href: string; label: string } {
  for (const [, items] of NAV) for (const i of items) {
    const need = routePermissionOf(i.href);
    if (!need || satisfies(held, need)) return { href: i.href, label: i.label };
  }
  return { href: '/account/security', label: 'Account & Security' };
}

/** "You do not have access" panel; `what` names the page or section, `link` offers a way out. */
export function NoAccess({ need, what = 'this page', link = true }: { need?: readonly string[] | null; what?: string; link?: boolean }) {
  const { permissions } = useLMS();
  const home = homeFor(permissions);
  const listed = (need ?? []).filter((p) => p !== UNREGISTERED_ROUTE);
  return (
    <Card icon="lock" title={`You do not have access to ${what}`}>
      <div className="al w" role="alert">
        <span className="i" />
        <div className="tx">
          Your roles do not include the {listed.length > 1 ? 'permissions' : 'permission'} needed for {what}
          {listed.length ? <> ({listed.map((p) => <span key={p} className="pill">{p}</span>)})</> : null}.
          <small>Nothing was loaded or changed. If you need this for your work, ask your system administrator to review your roles.</small>
        </div>
      </div>
      {link && <div className="bar"><Link className="btn btn-p" href={home.href}>Go to {home.label}</Link></div>}
    </Card>
  );
}

export default function PageGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const { currentUser } = useLMS();
  const can = useCan();
  usePermissionCacheReset();
  const need = routePermissionOf(pathname);
  if (need === null) return <>{children}</>;
  // Permissions are not known until /api/auth/me answers: mount nothing until then.
  if (!currentUser) return <div className="empty" role="status">Loading…</div>;
  if (!can(need)) return pathname === '/dashboard' ? <ToHome /> : <NoAccess need={need} />;
  return <>{children}</>;
}

/** Sign-in lands on /dashboard; a role without it (e.g. the Exploration Planner) is taken to its first page instead. */
function ToHome() {
  const { permissions } = useLMS();
  const router = useRouter();
  // Someone who raises land requests on the map starts on the map.
  const home = permissions.includes('requests:create') && permissions.includes('gis:read')
    ? { href: '/gis', label: 'GIS Land Map' } : homeFor(permissions);
  React.useEffect(() => { router.replace(home.href); }, [router, home.href]);
  return <div className="empty" role="status">Opening {home.label}…</div>;
}
