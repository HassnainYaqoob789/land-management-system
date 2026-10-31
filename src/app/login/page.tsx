'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthPage } from '@/components/ui/AuthCard';
import { SIGNIN_UNAVAILABLE_MESSAGE, type SigninProvider } from '@/lib/iam/signin-methods';
import { passkeySupported, signInWithPasskey } from '@/lib/client/passkey';
import DemoAccounts from '@/components/auth/DemoAccounts';

// The reference's sign-in card (legacy-demo/index.html .login-card) with the
// Mari Energies logo. Its demo-accounts table is deliberately absent: accounts
// here are real. Every method the server lists is shown; one that cannot be
// used right now is shown as unavailable with the reason, never as a dead link.

type Factor = 'totp' | 'recovery' | 'passkey';
interface Options { local: boolean; passkey: boolean | null; providers: SigninProvider[] }
type Done = { mustChangePassword?: boolean; mfaEnrollmentRequired?: boolean };

const KINDS = new Set(['oidc', 'saml', 'ldap']);
/** Only this application's own start routes are followed. */
const startPath = (u: unknown) => (typeof u === 'string' && /^\/api\/auth\/(oidc|saml)\/[a-z][a-z0-9-]{1,30}\/start$/.test(u) ? u : null);

function normalise(d: any): Options {
  const providers: SigninProvider[] = (Array.isArray(d?.providers) ? d.providers : []).flatMap((x: any) => {
    if (!x || typeof x.name !== 'string' || !KINDS.has(x.kind)) return [];
    const startUrl = x.kind === 'ldap' ? null : startPath(x.startUrl);
    const available = x.available !== false && (x.kind === 'ldap' || startUrl !== null);
    return [{ name: x.name, displayName: String(x.displayName ?? x.display_name ?? x.name), kind: x.kind, available, startUrl: available ? startUrl : null }];
  });
  return { local: d?.local !== false, passkey: typeof d?.passkey === 'boolean' ? d.passkey : null, providers };
}

const FIELD: React.CSSProperties = { width: '100%', padding: '10px 14px', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13.5px' };
const LINK: React.CSSProperties = { background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' };
const STACKED: React.CSSProperties = { marginTop: 8, whiteSpace: 'normal', textAlign: 'center' };

/** A method that exists but cannot be used now: focusable, inert, explained. */
function Unavailable({ id, label, reason }: { id: string; label: string; reason: string }) {
  return (
    <li>
      <button type="button" className="btn btn-s" aria-disabled="true" aria-describedby={id} style={STACKED} onClick={(e) => e.preventDefault()}>{label}</button>
      <p id={id} className="note u-mt-6" data-signin-unavailable="">{reason}</p>
    </li>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [opts, setOpts] = useState<Options | null>(null);
  const [via, setVia] = useState('local');   // 'local' or the name of an LDAP directory
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [factors, setFactors] = useState<Factor[]>(['totp', 'recovery', 'passkey']);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'password' | 'passkey' | 'code'>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<null | 'username' | 'password' | 'code'>(null);
  const [canPasskey, setCanPasskey] = useState(false);
  const [mode, setMode] = useState<'password' | 'sso'>('password');   // the sign-in toggle
  const userRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCanPasskey(passkeySupported());
    // Back from an external sign-in whose account has its own second factor:
    // the challenge arrives in the fragment (never sent to a server); drop it from the address bar.
    const m = /^#mfa=([A-Za-z0-9_-]{20,100})$/.exec(window.location.hash);
    if (m) { setChallenge(m[1]); window.history.replaceState(null, '', window.location.pathname); }
    let live = true;
    fetch('/api/auth/options', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) setOpts(normalise(d)); })
      .catch(() => { if (live) setOpts({ local: true, passkey: null, providers: [] }); });
    return () => { live = false; };
  }, []);

  const directories = (opts?.providers ?? []).filter((p) => p.kind === 'ldap');
  const usableDirectories = directories.filter((p) => p.available);
  const external = (opts?.providers ?? []).filter((p) => p.kind !== 'ldap');
  useEffect(() => {   // local sign-in switched off: start on the first directory
    if (!opts || opts.local) return;
    const first = opts.providers.find((p) => p.kind === 'ldap' && p.available);
    if (first) setVia((v) => (v === 'local' ? first.name : v));
  }, [opts]);

  const afterLogin = (d: Done) => router.push(d.mustChangePassword || d.mfaEnrollmentRequired ? '/account/security' : '/dashboard');
  const startAgain = () => { setChallenge(null); setCode(''); setUseRecovery(false); setFactors(['totp', 'recovery', 'passkey']); };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setMissing(null);
    if (!username.trim()) { setError('Enter your username.'); setMissing('username'); userRef.current?.focus(); return; }
    if (!password) { setError('Enter your password.'); setMissing('password'); pwRef.current?.focus(); return; }
    setBusy('password');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, ...(via !== 'local' ? { provider: via } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      setPassword('');
      if (!res.ok) { setError(data.error || 'Sign-in failed. Try again.'); pwRef.current?.focus(); return; }
      if (data.mfaRequired) {
        const offered: Factor[] = Array.isArray(data.methods) ? data.methods.filter((x: unknown) => x === 'totp' || x === 'recovery' || x === 'passkey') : [];
        setFactors(offered.length ? offered : ['totp', 'recovery']);
        setUseRecovery(!offered.includes('totp') && offered.includes('recovery'));
        setChallenge(data.challenge);
        return;
      }
      afterLogin(data);
    } catch { setError('The server could not be reached. Check your connection and try again.'); }
    finally { setBusy(null); }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setMissing(null);
    if (!code) { setError(useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code.'); setMissing('code'); codeRef.current?.focus(); return; }
    setBusy('code');
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, code, method: useRecovery ? 'recovery' : 'totp' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCode('');
        if (data.code === 'challenge_expired') startAgain(); else codeRef.current?.focus();
        setError(data.error || 'Verification failed.');
        return;
      }
      afterLogin(data);
    } catch { setError('The server could not be reached. Check your connection and try again.'); }
    finally { setBusy(null); }
  };

  const withPasskey = async () => {
    setError(null); setBusy('passkey');
    try {
      const r = await signInWithPasskey(username.trim() || undefined);
      if (r.ok) afterLogin(r); else setError(r.error);
    } catch { setError('Passkey sign-in did not complete. Try again, or use your password.'); }
    finally { setBusy(null); }
  };

  const passkeyEntry = () => {
    if (!opts || opts.passkey === null) return null;   // not known yet: show nothing rather than guess
    const label = 'Sign in with a passkey';
    if (!opts.passkey) return <Unavailable key="passkey" id="lgPkU" label={label} reason={SIGNIN_UNAVAILABLE_MESSAGE} />;
    if (!canPasskey) return <Unavailable key="passkey" id="lgPkU" label={label} reason="This browser or device does not support passkeys. Use your password instead." />;
    return (
      <li key="passkey">
        <button type="button" className="btn btn-s" style={STACKED} onClick={withPasskey} disabled={busy !== null} aria-busy={busy === 'passkey'}>
          {busy === 'passkey' ? 'Waiting for your passkey…' : label}</button>
      </li>
    );
  };
  const unavailableDirectories = directories.filter((p) => !p.available);
  const others = [passkeyEntry(),
    ...unavailableDirectories.map((p) => <Unavailable key={p.name} id={`lgU-${p.name}`} label={`Sign in with ${p.displayName}`} reason={SIGNIN_UNAVAILABLE_MESSAGE} />),
  ].filter(Boolean);
  // Single sign-on (OIDC / SAML). With none configured, SSO is still offered —
  // as unavailable, with the standard message — so users know where it lives.
  const ssoEntries = external.length
    ? external.map((p) => (p.available && p.startUrl
      ? <li key={p.name}><a className="btn btn-p" style={STACKED} href={p.startUrl}>Sign in with {p.displayName}</a></li>
      : <Unavailable key={p.name} id={`lgU-${p.name}`} label={`Sign in with ${p.displayName}`} reason={SIGNIN_UNAVAILABLE_MESSAGE} />))
    : [<Unavailable key="sso" id="lgSsoU" label="Sign in with SSO" reason={SIGNIN_UNAVAILABLE_MESSAGE} />];
  const toggle = (
    <div role="radiogroup" aria-label="How do you want to sign in?" className="signin-toggle"
      style={{ display: 'flex', gap: 0, margin: '4px 0 14px', border: '1px solid var(--line, #c9d3df)', borderRadius: 8, overflow: 'hidden' }}>
      {([['password', 'Username & password'], ['sso', 'Single sign-on (SSO)']] as const).map(([m, label]) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m}
          onClick={() => { setMode(m); setError(null); setMissing(null); }}
          onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setMode(mode === 'password' ? 'sso' : 'password'); } }}
          tabIndex={mode === m ? 0 : -1}
          style={{ flex: 1, padding: '8px 10px', border: 0, cursor: 'pointer', fontWeight: 600, fontSize: 13,
                   background: mode === m ? 'var(--brand, #0b3b6e)' : 'transparent', color: mode === m ? '#fff' : 'var(--text, #1f2d3d)' }}>
          {label}
        </button>
      ))}
    </div>
  );
  const errorBox = error && <p id="lgErr" className="err-msg" role="alert">{error}</p>;
  const codeFactor = factors.includes('totp') || factors.includes('recovery');

  return (
    <AuthPage title="Land Management System" back={false}
      sub={<>Mari Energies Limited · E&amp;P land lifecycle — acquisition, leases, ROW, compensation, GIS</>}>
      {!challenge ? (
        <>
          {toggle}
          {mode === 'sso' ? (
            <section aria-labelledby="lgSso">
              <h2 id="lgSso" style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px', color: 'var(--text)' }}>Sign in with your organisation account</h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{ssoEntries}</ul>
              <p className="note u-mt-12">Your access in the LMS still comes from the roles an administrator has assigned to you.</p>
            </section>
          ) : (<>
          <form onSubmit={submitPassword} noValidate aria-label="Sign in with a password">
            {usableDirectories.length > 0 && (
              <>
                <label htmlFor="lgM">Sign in with</label>
                <select id="lgM" name="method" value={via} onChange={(e) => { setVia(e.target.value); setError(null); }} style={FIELD}>
                  {opts?.local && <option value="local">LMS account</option>}
                  {usableDirectories.map((p) => <option key={p.name} value={p.name}>{p.displayName}</option>)}
                </select>
              </>
            )}
            <label htmlFor="lgU">Username</label>
            <input id="lgU" ref={userRef} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus
              aria-invalid={missing === 'username' || undefined} aria-describedby={error ? 'lgErr' : undefined}
              value={username} onChange={(e) => setUsername(e.target.value)} />
            <label htmlFor="lgP">Password</label>
            <input id="lgP" ref={pwRef} name="password" type="password" autoComplete="current-password" required
              aria-invalid={missing === 'password' || undefined} aria-describedby={error ? 'lgErr' : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} />
            {errorBox}
            <button className="btn btn-p" type="submit" disabled={busy !== null} aria-busy={busy === 'password'}>
              {busy === 'password' ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="note u-mt-12 u-ta-center">
              {via === 'local'
                ? <a href="/forgot-password">Forgot password?</a>
                : 'Your directory password is managed by your IT department.'}
            </p>
          </form>
          {/* Demo environments only: the server decides (see /api/auth/demo-accounts). */}
          <DemoAccounts onPick={(u, pw) => { setVia('local'); setUsername(u); setPassword(pw); setError(null); setMissing(null); }} />
          {others.length > 0 && (
            <section className="demo-accts" aria-labelledby="lgOther">
              <h2 id="lgOther" style={{ fontSize: 12, fontWeight: 700, margin: 0, color: 'var(--text)' }}>Other ways to sign in</h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{others}</ul>
            </section>
          )}
          </>)}
        </>
      ) : (
        <form onSubmit={submitCode} noValidate aria-label="Second step of sign-in">
          <p className="note">
            {!codeFactor ? 'Confirm it is you with the passkey on your device.'
              : useRecovery ? 'Enter one of the recovery codes you saved when you set up two-step verification. Each code works once.'
                : 'Enter the 6-digit code from your authenticator app.'}
          </p>
          {codeFactor && (
            <>
              <label htmlFor="lgC">{useRecovery ? 'Recovery code' : 'Verification code'}</label>
              <input id="lgC" ref={codeRef} name="code" autoComplete="one-time-code" required autoFocus
                inputMode={useRecovery ? 'text' : 'numeric'} pattern={useRecovery ? undefined : '[0-9]*'}
                maxLength={useRecovery ? 32 : 6} aria-invalid={missing === 'code' || undefined} aria-describedby={error ? 'lgErr' : undefined}
                value={code} onChange={(e) => setCode(e.target.value.trim())} />
            </>
          )}
          {!codeFactor && !(opts?.passkey !== false && canPasskey) && (
            <p className="note u-mt-12">This account confirms sign-in with a passkey, which this browser cannot use. Sign in on a device that
              holds your passkey, or contact your administrator.</p>
          )}
          {errorBox}
          {codeFactor && (
            <button className="btn btn-p" type="submit" disabled={busy !== null} aria-busy={busy === 'code'}>
              {busy === 'code' ? 'Verifying…' : 'Verify'}</button>
          )}
          {factors.includes('passkey') && opts?.passkey !== false && canPasskey && (
            <button type="button" className={`btn ${codeFactor ? 'btn-s' : 'btn-p'}`} style={codeFactor ? STACKED : undefined}
              onClick={withPasskey} disabled={busy !== null} aria-busy={busy === 'passkey'}>
              {busy === 'passkey' ? 'Waiting for your passkey…' : codeFactor ? 'Use a passkey instead' : 'Use your passkey'}</button>
          )}
          <p className="note u-mt-12 u-ta-center">
            {factors.includes('totp') && factors.includes('recovery') && (
              <>
                <button type="button" style={LINK} onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>
                  {useRecovery ? 'Use your authenticator app instead' : 'Use a recovery code instead'}</button>
                {' · '}
              </>
            )}
            <button type="button" style={LINK} onClick={() => { startAgain(); setError(null); }}>Start again</button>
          </p>
        </form>
      )}
      <p className="note u-mt-16 u-ta-center">Sign-ins are rate-limited and recorded in the security log.</p>
    </AuthPage>
  );
}
