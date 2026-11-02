// Navigation in the reference's groups, wording and icons (legacy-demo/assets/js/ui/screens.js
// NAV, app/shell.js NAV_ICONS). Land Requests, Provincial Revenue Systems and Account &
// Security are this application's additions; every reference screen it implements is listed.
//
// `perm` is what the page needs to open: the permission its primary API
// requires (UI-13). The same value drives the menu and the route guard
// (ROUTE_PERMISSIONS / routePermissionOf below, used by PageGuard), so a menu
// entry is shown exactly when the page would open. Sections that read other
// modules are gated inside the page. The server enforces every permission on
// every request regardless; this only keeps the UI honest.

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  perm?: string;
  /** Optional stricter permission(s) (any one suffices) to show this standalone screen in the Sidebar when `perm` is also granted as a lookup dependency. */
  menuPerm?: string | string[];
  /** Roles for which this standalone tab is hidden in the Sidebar (e.g. when the role only holds `perm` for background KPIs or dropdown pickers). */
  excludeRoles?: string[];
  /** Restrict Sidebar visibility to users who have access to this province (e.g. 'SND' for DBPFC). */
  provinceOnly?: string;
}

export const NAV: [string, NavItem[]][] = [
  ['Overview', [
    // KPI tiles come from /api/analytics/kpis (reports:read); each tile is further gated by its module.
    { href: '/dashboard', label: 'Executive Dashboard', icon: 'dash', perm: 'reports:read' },
    { href: '/projdash', label: 'Project Dashboard', icon: 'target', perm: 'projects:read', menuPerm: ['gis:read', 'projects:create'] },
    { href: '/inbox', label: 'Approvals & Alerts', icon: 'bell', perm: 'inbox:read' },
    // /api/calendar filters each register by its own :read permission.
    { href: '/calendar', label: 'Calendar', icon: 'cal', menuPerm: ['leases:create', 'leases:update', 'rows:read', 'legal:create', 'requests:read'] },
    { href: '/gis', label: 'GIS Land Map', icon: 'pin', perm: 'gis:read' },
  ]],
  ['Master Data', [
    { href: '/units', label: 'Administrative Hierarchy', icon: 'bank', menuPerm: ['surveys:create', 'settings:update', 'gis:read'], excludeRoles: ['negotiation-officer'] },
    // Province figures come from /api/analytics/kpis (reports:read).
    { href: '/province', label: 'Provincial Revenue Systems', icon: 'map', perm: 'reports:read', menuPerm: ['gis:read'], excludeRoles: ['data-entry', 'negotiation-officer'] },
    { href: '/projects', label: 'Projects / Well Locations', icon: 'rig', perm: 'projects:read', menuPerm: ['projects:create', 'projects:update', 'requests:create', 'requests:read'] },
    { href: '/surveys', label: 'Survey / Khasra Register', icon: 'map', perm: 'surveys:read', menuPerm: ['surveys:create', 'surveys:update', 'legal:create', 'audit_logs:read', 'requests:read'] },
    { href: '/landowners', label: 'Landowners', icon: 'user', perm: 'landowners:read' },
  ]],
  ['Land Operations', [
    { href: '/requests', label: 'Land Requests', icon: 'file', perm: 'requests:read' },
    { href: '/acquisitions', label: 'Acquisition & Title', icon: 'clip', perm: 'acquisitions:read' },
    { href: '/cases', label: 'Compensation Cases', icon: 'doc', perm: 'cases:read', menuPerm: ['cases:create', 'cases:approve', 'payments:verify', 'audit_logs:read'] },
    { href: '/leases', label: 'Leases & Agreements', icon: 'cal', perm: 'leases:read', menuPerm: ['leases:create', 'leases:update', 'payments:verify', 'audit_logs:read'] },
    { href: '/rows', label: 'ROW & Pipelines', icon: 'route', perm: 'rows:read' },
    { href: '/encroachments', label: 'Encroachments', icon: 'warn', perm: 'encroachments:read' },
    { href: '/mutations', label: 'Mutation & Succession', icon: 'repeat', perm: 'mutations:read' },
    { href: '/legal', label: 'Legal & Litigation', icon: 'scale', perm: 'legal:read' },
  ]],
  ['Finance', [
    { href: '/payments', label: 'Payments & Cheques', icon: 'wallet', perm: 'payments:read', menuPerm: ['payments:create', 'payments:verify', 'payments:release', 'audit_logs:read'] },
    { href: '/dbpfc', label: 'DBPFC — Sindh Govt Land', icon: 'bldg', perm: 'dbpfc:read', provinceOnly: 'SND' },
    { href: '/budgets', label: 'Budgets', icon: 'trend', perm: 'budgets:read' },
  ]],
  ['Community', [
    { href: '/grievances', label: 'Grievances & IIR', icon: 'mega', perm: 'grievances:read' },
  ]],
  ['Records & Reports', [
    { href: '/reports', label: 'Reports', icon: 'calc', perm: 'reports:read', menuPerm: ['reports:export', 'audit_logs:read', 'gis:read'], excludeRoles: ['system-administrator', 'data-entry', 'negotiation-officer', 'legal-advisor'] },
    // 0056: read-only landowner register (owners × khasra, province-wise) for the overseeing roles, the administrator included.
    { href: '/landowner-register', label: 'Landowner Register', icon: 'user', perm: 'landowner_report:read' },
    { href: '/documents', label: 'Documents', icon: 'folder', perm: 'documents:read' },
    { href: '/import', label: 'Data Upload', icon: 'down', perm: 'import:read' },
    { href: '/audit', label: 'Audit Trail', icon: 'receipt', perm: 'audit_logs:read' },
  ]],
  ['System', [
    { href: '/users', label: 'Users & Roles', icon: 'lock', perm: 'users:read' },
    { href: '/roles', label: 'Roles & Permissions', icon: 'shield', perm: 'roles:read' },
    { href: '/matrix', label: 'Approval Matrix', icon: 'compass', perm: 'settings:read' },
    { href: '/settings', label: 'Settings', icon: 'gear', perm: 'settings:read', menuPerm: ['settings:update', 'identity_settings:configure', 'identity_settings:read'] },
    { href: '/arch', label: 'Architecture & Security', icon: 'layers', menuPerm: ['users:read', 'roles:read', 'audit_logs:read'] },
    { href: '/account/security', label: 'Account & Security', icon: 'shield' },
  ]],
];

/** Whether a menu entry should appear in the Sidebar for the signed-in user. */
export function showInMenu(
  item: NavItem,
  permissions: readonly string[],
  provinces: readonly string[] = [],
  roles: readonly string[] = []
): boolean {
  if (item.perm && !permissions.includes(item.perm)) return false;
  if (item.menuPerm) {
    const list = typeof item.menuPerm === 'string' ? [item.menuPerm] : item.menuPerm;
    if (!list.some((p) => permissions.includes(p))) return false;
  }
  if (item.excludeRoles && roles.length > 0 && roles.every((r) => item.excludeRoles!.includes(r))) {
    return false;
  }
  if (item.provinceOnly && provinces.length > 0 && !provinces.includes(item.provinceOnly)) {
    return false;
  }
  return true;
}

export function navFor(pathname: string): { group: string; item: NavItem } | null {
  for (const [group, items] of NAV) for (const item of items)
    if (pathname === item.href || pathname.startsWith(item.href + '/')) return { group, item };
  return null;
}

// ---- route guard table (UI-08 / UI-13) -------------------------------------

/** Pages inside the Shell that are not menu entries. */
const OTHER_ROUTES: [string, string[] | null][] = [
  ['/', null],                       // redirects to /dashboard
];

/**
 * What each page needs, as `resource:action` strings (all of them); null = any
 * signed-in user. Nested routes inherit their parent's entry (/roles/x → /roles).
 * A route that is not listed here is refused (default deny): register every
 * new page that renders inside the Shell.
 */
export const ROUTE_PERMISSIONS: Readonly<Record<string, readonly string[] | null>> = Object.freeze(Object.fromEntries([
  ...NAV.flatMap(([, items]) => items.map((i) => [i.href, i.perm ? [i.perm] : null] as const)),
  ...OTHER_ROUTES,
]));

/** A permission no role holds: what an unregistered route "needs". */
export const UNREGISTERED_ROUTE = 'unregistered:route';

function normalisePath(pathname: string): string {
  const p = (pathname || '/').split(/[?#]/)[0] || '/';
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

/** The permissions a page needs (longest matching entry); null = any signed-in user. */
export function routePermissionOf(pathname: string): string[] | null {
  const path = normalisePath(pathname);
  let best: string | null = null;
  for (const href of Object.keys(ROUTE_PERMISSIONS)) {
    const hit = href === '/' ? path === '/' : path === href || path.startsWith(href + '/');
    if (hit && (best === null || href.length > best.length)) best = href;
  }
  if (best === null) return [UNREGISTERED_ROUTE];
  const need = ROUTE_PERMISSIONS[best];
  return need ? [...need] : null;
}

/** True when `held` satisfies `need` (all of them, or any one with mode 'any'). An empty need is satisfied. */
export function satisfies(held: readonly string[], need: string | readonly string[], mode: 'all' | 'any' = 'all'): boolean {
  const list = typeof need === 'string' ? [need] : need;
  if (!list.length) return true;
  return mode === 'any' ? list.some((p) => held.includes(p)) : list.every((p) => held.includes(p));
}

/**
 * `satisfies`, for a record in `province`: refused without a province; a user with
 * no province list is not narrowed further (see useCanIn in src/lib/client/permissions.ts).
 */
export function satisfiesIn(held: readonly string[], provinces: readonly string[], need: string | readonly string[],
  province: string | null | undefined, mode: 'all' | 'any' = 'all'): boolean {
  return satisfies(held, need, mode) && !!province && (!provinces.length || provinces.includes(province));
}

// Province presentation from legacy-demo/assets/js/core/engine.js PROV.
export const PROVINCES: Record<string, { name: string; color: string; grad: string; levels: string[]; rev: string; units: string[] }> = {
  SND: { name: 'Sindh', color: '#2368b0', grad: 'linear-gradient(135deg,#1c6dc4,#0e3f78)', levels: ['District', 'Taluka', 'Deh'], rev: 'Survey No. & Block No.', units: ['Acre', 'Jireb', 'Ghunta'] },
  BAL: { name: 'Balochistan', color: '#c26a17', grad: 'linear-gradient(135deg,#d07a24,#8a4410)', levels: ['District', 'Sub-Division', 'Tehsil', 'Sub-Tehsil / Qanungo Halka', 'Mouza'], rev: 'Khasra No.', units: ['Acre', 'Rod', 'Pole'] },
  PNJ: { name: 'Punjab', color: '#178a4c', grad: 'linear-gradient(135deg,#1f9e5a,#0d5c32)', levels: ['District', 'Tehsil', 'Qanungo Halka', 'Mouza'], rev: 'Khasra No.', units: ['Acre', 'Kanal', 'Marla'] },
  KPK: { name: 'Khyber Pakhtunkhwa', color: '#b8324a', grad: 'linear-gradient(135deg,#c93b55,#7c1a2c)', levels: ['District', 'Sub-Division', 'Tehsil', 'Mouza'], rev: 'Khasra No. (Rural) / Survey No. (Urban)', units: ['Acre', 'Kanal', 'Bigha'] },
};

export const humanRole = (code: string) =>
  code.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
