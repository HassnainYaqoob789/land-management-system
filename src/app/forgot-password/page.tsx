'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AuthPage, Alert } from '@/components/ui/AuthCard';

// Self-service reset for LMS (local) accounts. The answer is the same whether
// or not the account exists, and it never says a message was delivered.
export default function ForgotPasswordPage() {
  const [username, setUsername] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => { if (done) result.current?.focus(); }, [done]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (!username.trim()) { setError('Enter your username.'); input.current?.focus(); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/password/forgot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'The request could not be sent. Try again later.'); return; }
      setDone(typeof data.message === 'string' ? data.message : 'Request received.');
    } catch { setError('The server could not be reached. Check your connection and try again.'); }
    finally { setLoading(false); }
  };

  return (
    <AuthPage title="Reset your password">
      {done ? (
        <div ref={result} tabIndex={-1}>
          <Alert kind="ok">{done}</Alert>
          <p className="note u-mt-12">Didn&apos;t ask for this? You can ignore any e-mail you receive; your password stays the same.</p>
        </div>
      ) : (
        <form onSubmit={submit} noValidate aria-label="Request a password reset link">
          <p className="note">Enter the username of your LMS account. If the account has an e-mail address on file, a single-use reset
            link is sent to it. Directory (Active Directory) passwords are reset by your IT department.</p>
          <label htmlFor="fpId">Username</label>
          <input id="fpId" ref={input} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus
            aria-invalid={(!!error && !username.trim()) || undefined} aria-describedby={error ? 'fpErr' : undefined}
            value={username} onChange={(e) => setUsername(e.target.value)} />
          {error && <p id="fpErr" className="err-msg" role="alert">{error}</p>}
          <button className="btn btn-p" type="submit" disabled={loading} aria-busy={loading}>
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthPage>
  );
}
