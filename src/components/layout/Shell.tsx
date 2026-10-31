'use client';

// The application shell, in the markup of legacy-demo (dashboard/index.html and
// assets/js/app/shell.js): fixed sidebar, topbar, breadcrumb bar, role bar,
// content and footer. Authentication state comes from /api/auth/me; nothing
// here decides what a user may do — the server does that on every request.
// The shell keeps the UI in step with the server: it re-reads permissions
// (usePermissionRefresh), guards each page (PageGuard), and handles the
// server's "forbidden" and "confirm it's you" answers for every fetch().

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import Header from './Header';
import Sidebar from './Sidebar';
import ProvinceChooser from './ProvinceChooser';
import { AppUser } from '@/lib/types';
import { navFor, humanRole, PROVINCES, routePermissionOf, satisfies, showInMenu } from './nav';
import PageGuard from '@/components/auth/PageGuard';
import { usePermissionRefresh, onForbidden } from '@/lib/client/permissions';
import { passkeySupported, reauthWithPasskey } from '@/lib/client/passkey';
import { setPrintIdentity } from '@/lib/client/print';
import { Modal, Field, ErrorNote } from '@/components/legacy/ui';
import { dialogOpen } from '@/components/legacy/a11y';
import GlobalSearch from '@/components/search/GlobalSearch';

interface LMSContextType {
  currentUser: AppUser | null;
  activeProvince: string;
  setActiveProvince: (p: string) => void;
  refreshUser: () => void;
  permissions: string[];
  provinces: string[];
}

export const LMSContext = createContext<LMSContextType>({
  currentUser: null,
  activeProvince: 'ALL',
  setActiveProvince: () => {},
  refreshUser: () => {},
  permissions: [],
  provinces: [],
});

export const useLMS = () => useContext(LMSContext);

// ---- fetch() for the whole application ---------------------------------------
// Same-origin writes carry the per-session CSRF token; an expired session or an
// outstanding MFA / password requirement sends the user where they need to go;
// a 403 'forbidden' re-reads permissions (onForbidden); a 403 'reauth_required'
// asks the user to confirm it's them and retries the original request once.
// Installed once; every page's fetch() picks it up unchanged.
let csrfToken = '';
let installed = false;
let askReauth: (() => Promise<boolean>) | null = null;
let pendingReauth: Promise<boolean> | null = null;
const REAUTH_URL = '/api/auth/reauth';

/** One prompt at a time: concurrent refusals share it. */
function requestReauth(): Promise<boolean> {
  if (!askReauth) return Promise.resolve(false);
  if (!pendingReauth) pendingReauth = askReauth().finally(() => { pendingReauth = null; });
  return pendingReauth;
}

function installAuthFetch() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const sameOrigin = url.startsWith('/') || url.startsWith(location.origin);
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (sameOrigin && !['GET', 'HEAD'].includes(method) && csrfToken) {
      const h = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      h.set('X-CSRF-Token', csrfToken);
      init = { ...init, headers: h };
    }
    // A request body that is a stream cannot be sent twice; everything else can be retried.
    const retryable = !(init.body instanceof ReadableStream);
    const retryInput = input instanceof Request && retryable ? input.clone() : input;
    const res = await original(input, init);
    if (!sameOrigin || (res.status !== 401 && res.status !== 403)) return res;
    const body = await res.clone().json().catch(() => ({}));
    if (body.code === 'unauthenticated') window.location.href = '/login';
    else if ((body.code === 'mfa_required' || body.code === 'password_change_required') && !location.pathname.startsWith('/account/security'))
      window.location.href = '/account/security';
    else if (body.code === 'forbidden') onForbidden();
    else if (body.code === 'reauth_required' && retryable && !url.includes(REAUTH_URL)) {
      if (await requestReauth()) {
        const again = await original(retryInput, init);
        if (again.status === 403) {
          const b2 = await again.clone().json().catch(() => ({}));
          if (b2.code === 'forbidden') onForbidden();
        }
        return again;
      }
    }
    return res;
  };
}

// ---- "Confirm it's you" ----------------------------------------------------------
function ReauthDialog({ open, onDone }: { open: boolean; onDone: (ok: boolean) => void }) {
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkey, setPasskey] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSecret(''); setError(null); setMode('password'); setBusy(false);
    try { setPasskey(passkeySupported()); } catch { setPasskey(false); }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret.trim()) { setError(mode === 'password' ? 'Enter your password.' : 'Enter the code from your authenticator.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch(REAUTH_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'password' ? { password: secret } : { code: secret.trim() }),
      });
      if (res.ok) { setSecret(''); onDone(true); return; }
      const b = await res.json().catch(() => ({}));
      setError(res.status === 429 ? (b.error || 'Too many failed attempts. Try again in a few minutes.')
        : mode === 'password' ? 'That password did not match. Try again.' : 'That code did not match. Try again.');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally { setBusy(false); }
  };

  const withPasskey = async () => {
    setBusy(true); setError(null);
    try {
      if (await reauthWithPasskey()) { onDone(true); return; }
      setError('The passkey was not accepted. Use your password instead.');
    } catch { setError('The passkey was not accepted. Use your password instead.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} size="sm" stacked icon="lock" title="Confirm it’s you" onClose={() => onDone(false)}
      footer={<>
        <button type="button" className="btn btn-s" onClick={() => onDone(false)} disabled={busy}>Cancel</button>
        <button type="submit" form="reauthForm" className="btn btn-p" disabled={busy}>{busy ? 'Checking…' : 'Confirm and continue'}</button>
      </>}>
      <form id="reauthForm" onSubmit={submit} noValidate>
        <p className="u-mb-10">This is a sensitive change. Confirm your identity and the action you started will continue.</p>
        {error && <ErrorNote>{error}</ErrorNote>}
        {mode === 'password' ? (
          <Field label="Password" required htmlFor="reauthPw">
            <input id="reauthPw" type="password" autoComplete="current-password" value={secret}
              onChange={(e) => setSecret(e.target.value)} aria-invalid={!!error || undefined} />
          </Field>
        ) : (
          <Field label="Authenticator code" required htmlFor="reauthCode" hint="The 6-digit code from your authenticator app.">
            <input id="reauthCode" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={secret}
              onChange={(e) => setSecret(e.target.value)} aria-invalid={!!error || undefined} />
          </Field>
        )}
        <div className="bar">
          <button type="button" className="btn btn-s btn-sm" onClick={() => { setMode(mode === 'password' ? 'code' : 'password'); setSecret(''); setError(null); }}>
            {mode === 'password' ? 'Use an authenticator code instead' : 'Use your password instead'}
          </button>
          {passkey && <button type="button" className="btn btn-s btn-sm" onClick={withPasskey} disabled={busy}>Use a passkey</button>}
        </div>
      </form>
    </Modal>
  );
}

const CTX_KEY = 'lms_ctx';
const ALL = Object.keys(PROVINCES);
const FOOTER_LINKS: [string, string][] = [['/dashboard', 'Dashboard'], ['/reports', 'Reports'], ['/audit', 'Audit trail'], ['/account/security', 'Account & security']];

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [provinces, setProvinces] = useState<string[]>([]);
  const [activeProvince, setProvinceState] = useState<string>('ALL');
  const [ready, setReady] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [reauth, setReauth] = useState(false);
  const reauthDone = useRef<((ok: boolean) => void) | null>(null);
  const [printedAt, setPrintedAt] = useState('');
  const sideRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);

  const setActiveProvince = useCallback((p: string) => {
    setProvinceState(p);
    try { sessionStorage.setItem(CTX_KEY, p); } catch { /* private mode: the choice lasts this page only */ }
    setChoosing(false);
    setReady(true);
  }, []);

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (!data.user) return;
      setCurrentUser(data.user);
      if (data.csrfToken) csrfToken = data.csrfToken;
      setPermissions(data.permissions || []);
      setRoles(data.roles || []);
      const allowed: string[] = data.provinces || [];
      setProvinces(allowed);
      const onSecurity = location.pathname.startsWith('/account/security');
      if ((data.mustChangePassword || data.mfa?.enrolmentOutstanding) && !onSecurity) {
        window.location.href = '/account/security';
        return;
      }
      // The province context, as the reference keeps it: chosen once per
      // sign-in, remembered across screens, and limited to the user's scope.
      let saved: string | null = null;
      try { saved = sessionStorage.getItem(CTX_KEY); } catch { /* ignore */ }
      const all = ALL.every((p) => allowed.includes(p));
      const valid = (p: string | null) => !!p && (p === 'ALL' ? all : allowed.includes(p));
      if (valid(saved)) { setProvinceState(saved!); setReady(true); }
      else if (allowed.length === 1 || (onSecurity && allowed.length)) setActiveProvince(all ? 'ALL' : allowed[0]);
      else if (!allowed.length) setReady(true);   // no province scope: pages show what the server allows
      else setChoosing(true);
    } catch (e) {
      console.error(e);
    }
  }, [setActiveProvince]);

  useEffect(() => { installAuthFetch(); fetchUser(); }, [fetchUser]);
  // Permissions changed by an administrator reach this tab on focus, every 60 s and after a 403.
  usePermissionRefresh(fetchUser);

  // The re-authentication prompt, for installAuthFetch.
  useEffect(() => {
    askReauth = () => new Promise<boolean>((resolve) => { reauthDone.current = resolve; setReauth(true); });
    return () => {
      askReauth = null;
      reauthDone.current?.(false);    // a page change while prompting cancels the request
      reauthDone.current = null;
    };
  }, []);
  const finishReauth = useCallback((ok: boolean) => {
    setReauth(false);
    const done = reauthDone.current; reauthDone.current = null;
    done?.(ok);
  }, []);

  useEffect(() => { setPrintIdentity(currentUser ? { user: currentUser.full_name || currentUser.username } : null); }, [currentUser]);
  // The print-only letterhead says when the page was printed.
  useEffect(() => {
    const stamp = () => setPrintedAt(new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    window.addEventListener('beforeprint', stamp);
    return () => window.removeEventListener('beforeprint', stamp);
  }, []);

  // ---- the tablet / phone drawer (UX-08) ----
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 980px)');
    const sync = () => { setNarrow(mq.matches); if (!mq.matches) setDrawer(false); };   // rotation to wide closes it
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  useEffect(() => { setDrawer(false); }, [pathname]);
  const drawerOpen = narrow && drawer;
  const closeDrawer = useCallback((refocus: boolean) => {
    setDrawer(false);
    if (refocus) burgerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!drawerOpen) return;
    sideRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dialogOpen()) { e.preventDefault(); closeDrawer(true); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

  const here = navFor(pathname);
  const title = here?.item.label ?? 'Land Management System';
  const group = here?.group ?? '';
  const roleNames = roles.map(humanRole);
  const scope = provinces.length && ALL.every((p) => provinces.includes(p))
    ? 'All provinces' : provinces.map((p) => PROVINCES[p]?.name ?? p).join(', ');
  const footerLinks = FOOTER_LINKS.filter(([href]) => {
    const need = routePermissionOf(href);
    const nav = navFor(href);
    return (!need || satisfies(permissions, need)) && (!nav || showInMenu(nav.item, permissions, provinces, roles));
  });

  return (
    <LMSContext.Provider value={{ currentUser, activeProvince, setActiveProvince, refreshUser: fetchUser, permissions, provinces }}>
      <a className="skip-link" href="#content">Skip to main content</a>
      <div className="layout">
        <Sidebar permissions={permissions} provinces={provinces} roles={roles} open={drawerOpen} hidden={narrow && !drawer} ref={sideRef} onNavigate={() => setDrawer(false)} />
        {/* While the drawer is open on a narrow screen, the page behind it is inert. */}
        <div className="main" inert={drawerOpen || undefined}>
          <Header
            title={title}
            sub={`Mari Energies LMS / ${group ? group + ' / ' : ''}${title}`}
            currentUser={currentUser}
            roleName={roleNames[0] ?? ''}
            permissions={permissions}
            activeProvince={activeProvince}
            onChooseProvince={() => setChoosing(true)}
            drawerOpen={drawerOpen}
            onToggleDrawer={() => setDrawer((d) => !d)}
            burgerRef={burgerRef}
            search={currentUser ? <GlobalSearch permissions={permissions} activeProvince={activeProvince} /> : null}
          />
          <nav className="crumbs" aria-label="Breadcrumb">
            <a href="/dashboard">Home</a><span className="sep" aria-hidden="true">›</span>
            {group && <><span>{group}</span><span className="sep" aria-hidden="true">›</span></>}
            <span aria-current="page">{title}</span>
          </nav>
          {currentUser && (
            <div className="role-bar">
              {roleNames.slice(0, 2).map((r) => <span key={r} className="b b-p">{r}</span>)}
              <span className="who">{currentUser.full_name}{currentUser.position ? ` · ${currentUser.position}` : ''}</span>
              <span className="says">Province access: {scope || '—'}. Every action is checked by the server and recorded in the audit trail.</span>
            </div>
          )}
          {/* Printing the page itself: letterhead and credit (print only; src/styles/print-document.css). */}
          <div className="print-only print-head" aria-hidden="true">
            <img src="/images/mari-energies-logo.png" alt="" width={44} height={44} />
            <div><b>Mari Energies Limited</b><span>Land Management System · {title}</span></div>
            <span className="grow" />
            <span>{printedAt ? `Printed ${printedAt}` : ''}{currentUser ? ` · ${currentUser.full_name || currentUser.username}` : ''}</span>
          </div>
          <h2 className="sr-only">{title} — page content</h2>
          <main className="content" id="content" tabIndex={-1}>
            {/* Keyed by province: a change of province remounts the screen, so a
                response still in flight for the previous province can never
                overwrite the new one (the reference re-renders the screen too). */}
            {ready
              ? <React.Fragment key={activeProvince}><PageGuard>{children}</PageGuard></React.Fragment>
              : <div className="empty" role="status">Loading…</div>}
          </main>
          <div className="print-only print-foot" aria-hidden="true">Mari Energies Limited · Developed by Alisons Technology</div>
          <footer className="site-foot">
            <span className="credit">© Mari Energies Limited · Developed by Alisons Technology</span>
            <span className="grow" />
            {footerLinks.length > 0 && (
              <nav aria-label="Footer links">
                {footerLinks.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
              </nav>
            )}
          </footer>
        </div>
      </div>
      {drawerOpen && <div className="side-backdrop show" aria-hidden="true" onClick={() => closeDrawer(true)} />}
      {choosing && (
        <ProvinceChooser
          allowed={provinces}
          userName={currentUser?.full_name ?? ''}
          roleName={roleNames[0] ?? ''}
          onChoose={setActiveProvince}
          onClose={ready ? () => setChoosing(false) : undefined}
        />
      )}
      <ReauthDialog open={reauth} onDone={finishReauth} />
    </LMSContext.Provider>
  );
}
