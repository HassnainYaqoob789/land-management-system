'use client';

import React, { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AuthPage, Alert } from '@/components/ui/AuthCard';

// Redeems a password-reset link or an invitation link (purpose=invitation).
// The token is read once and then removed from the address bar; it is never
// shown or edited on screen. The link is checked before anything is typed.
function ResetForm() {
  const sp = useSearchParams();
  const [token] = useState(() => sp.get('token') || '');
  const [purpose] = useState<'invitation' | 'password_reset'>(() => (sp.get('purpose') === 'invitation' ? 'invitation' : 'password_reset'));
  const [state, setState] = useState<'checking' | 'ready' | 'invalid' | 'done'>(token ? 'checking' : 'invalid');
  const [minLength, setMinLength] = useState(12);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const result = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) return;
    window.history.replaceState(null, '', purpose === 'invitation' ? '/reset-password?purpose=invitation' : '/reset-password');
    let live = true;
    fetch('/api/auth/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, purpose, check: true }) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok && d.valid) { setMinLength(Number(d.minLength) || 12); setState('ready'); } else setState('invalid');
      })
      .catch(() => { if (live) { setError('The server could not be reached. Reload the page to try again.'); setState('ready'); } });
    return () => { live = false; };
  }, [token, purpose]);
  useEffect(() => { if (state === 'done' || state === 'invalid') result.current?.focus(); }, [state]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (pw.length < minLength) { setError(`Use at least ${minLength} characters.`); first.current?.focus(); return; }
    if (pw !== pw2) { setError('The two passwords do not match.'); return; }
    setLoading(true);
    try {
      const r = await fetch('/api/auth/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, newPassword: pw, purpose }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setPw(''); setPw2(''); setState('done'); return; }
      if (d.code === 'bad_token') { setState('invalid'); return; }
      setError(d.error || 'The password could not be set.');
      first.current?.focus();
    } catch { setError('The server could not be reached. Check your connection and try again.'); }
    finally { setLoading(false); }
  };

  if (state === 'checking') return <p className="note" role="status">Checking your link…</p>;
  if (state === 'invalid') return (
    <div ref={result} tabIndex={-1}>
      <Alert kind="error">This link is invalid, has already been used, or has expired.</Alert>
      {purpose === 'password_reset'
        ? <p className="note u-mt-12"><Link href="/forgot-password">Ask for a new reset link</Link></p>
        : <p className="note u-mt-12">Ask your administrator to send a new invitation.</p>}
    </div>
  );
  if (state === 'done') return (
    <div ref={result} tabIndex={-1}>
      <Alert kind="ok">Your password is set, and any other signed-in sessions of this account have been ended. <Link href="/login">Sign in</Link>.</Alert>
    </div>
  );
  return (
    <form onSubmit={submit} noValidate aria-label="Choose a new password">
      {purpose === 'invitation' && <p className="note">Welcome. Choose the password for your new account.</p>}
      <p className="note" id="pwHint">At least {minLength} characters. A long phrase is easier to remember and harder to guess than a short complex
        word. Do not reuse a recent password or include your name or username.</p>
      <label htmlFor="pw">New password</label>
      <input id="pw" ref={first} type="password" required minLength={minLength} autoComplete="new-password" autoFocus
        aria-describedby={error ? 'pwHint pwErr' : 'pwHint'} value={pw} onChange={(e) => setPw(e.target.value)} />
      <label htmlFor="pw2">Confirm new password</label>
      <input id="pw2" type="password" required minLength={minLength} autoComplete="new-password"
        aria-describedby={error ? 'pwErr' : undefined} value={pw2} onChange={(e) => setPw2(e.target.value)} />
      {error && <p id="pwErr" className="err-msg" role="alert">{error}</p>}
      <button type="submit" disabled={loading} aria-busy={loading} className="btn btn-p">{loading ? 'Saving…' : 'Set password'}</button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return <AuthPage title="Set your password"><Suspense fallback={null}><ResetForm /></Suspense></AuthPage>;
}
