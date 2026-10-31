'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Alert } from '@/components/ui/AuthCard';
import { Field, Modal, Table, fmtDate } from '@/components/legacy/ui';
import { SIGNIN_UNAVAILABLE_MESSAGE } from '@/lib/iam/signin-methods';
import {
  PasskeyError, listPasskeys, passkeySupported, reauthWithPasskey, registerPasskey, removePasskey,
  type PasskeyInfo, type PasskeyList,
} from '@/lib/client/passkey';

type Me = { mustChangePassword: boolean; mfa: { enrolled: boolean; required: boolean; enrolmentOutstanding: boolean };
            user: { username: string; full_name: string } };

const post = async (url: string, body: object = {}) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
};

function ChangePassword({ forced, onDone }: { forced: boolean; onDone: () => void }) {
  const [cur, setCur] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(null);
    if (pw !== pw2) { setMsg({ kind: 'error', text: 'The two new passwords do not match.' }); return; }
    setBusy(true);
    const r = await post('/api/auth/password', { currentPassword: cur, newPassword: pw });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: 'error', text: r.d.error || 'Could not change the password.' }); return; }
    setCur(''); setPw(''); setPw2('');
    setMsg({ kind: 'ok', text: 'Password changed. Your other sessions have been signed out.' });
    onDone();
  };
  return (
    <Card title={forced ? 'Change your password to continue' : 'Password'}>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={submit} className="u-mw-380">
        <Field label="Current password" htmlFor="cur" required>
          <input id="cur" type="password" required autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New password" htmlFor="new" required hint="At least 12 characters. A long phrase works well.">
          <input id="new" type="password" required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="Confirm new password" htmlFor="new2" required>
          <input id="new2" type="password" required autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        <button type="submit" disabled={busy} className="btn btn-p">{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </Card>
  );
}

function RecoveryCodes({ codes, onAck }: { codes: string[]; onAck: () => void }) {
  return (
    <div>
      <Alert kind="ok">Save these recovery codes somewhere safe. Each works once if you lose your authenticator. They will not be shown again.</Alert>
      <div className="totals u-mt-10 u-mb-10" role="list" aria-label="Recovery codes">
        {codes.map((c) => <div key={c} role="listitem" className="mono"><b>{c}</b></div>)}
      </div>
      <button type="button" onClick={onAck} className="btn btn-s">I have saved them</button>
    </div>
  );
}

function Authenticator({ me, totpOn, refresh }: { me: Me; totpOn: boolean; refresh: () => void }) {
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [reauthPw, setReauthPw] = useState('');
  const [needReauth, setNeedReauth] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setErr(null); setBusy(true);
    const r = await post('/api/auth/mfa/totp/start');
    setBusy(false);
    if (!r.ok) { setErr(r.d.error || 'Could not start enrolment.'); return; }
    setSetup({ qr: 'data:image/svg+xml;base64,' + btoa(r.d.qrSvg), secret: r.d.secret });
  };
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    const r = await post('/api/auth/mfa/totp/confirm', { code });
    setBusy(false);
    if (!r.ok) { setErr(r.d.error || 'That code is not valid.'); return; }
    setSetup(null); setCode(''); setCodes(r.d.recoveryCodes);
  };
  const regenerate = async () => {
    setErr(null); setBusy(true);
    const r = await post('/api/auth/mfa/recovery');
    setBusy(false);
    if (r.status === 403 && r.d.code === 'reauth_required') { setNeedReauth(true); return; }
    if (!r.ok) { setErr(r.d.error || 'Could not generate codes.'); return; }
    setCodes(r.d.recoveryCodes);
  };
  const reauth = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    const r = await post('/api/auth/reauth', { password: reauthPw });
    setBusy(false); setReauthPw('');
    if (!r.ok) { setErr(r.d.error || 'That did not match.'); return; }
    setNeedReauth(false); regenerate();
  };

  return (
    <Card title="Authenticator app (two-step verification)">
      {err && <Alert kind="error">{err}</Alert>}
      {codes ? <RecoveryCodes codes={codes} onAck={() => { setCodes(null); refresh(); }} /> :
       totpOn ? (
        <div>
          <p className="u-mb-10"><span className="b b-g">Enrolled</span> You will be asked for a code from your authenticator app at each sign-in.</p>
          {needReauth ? (
            <form onSubmit={reauth} className="u-mw-380">
              <Field label="Confirm your password to continue" htmlFor="reauth" required>
                <input id="reauth" type="password" required autoComplete="current-password" value={reauthPw} onChange={(e) => setReauthPw(e.target.value)} /></Field>
              <button type="submit" disabled={busy} className="btn btn-p">Confirm</button>
            </form>
          ) : <button type="button" onClick={regenerate} disabled={busy} className="btn btn-s">Generate new recovery codes</button>}
        </div>
      ) : setup ? (
        <form onSubmit={confirm} className="u-mw-380">
          <p className="note u-mb-10">Scan this with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…), then enter the 6-digit code it shows.</p>
          <img src={setup.qr} alt="QR code for authenticator enrolment" width={200} height={200} className="qr-box" />
          <p className="note u-mt-8 u-mb-10">Can&apos;t scan? Enter this key: <code className="mono">{setup.secret}</code></p>
          <Field label="Code" htmlFor="totp" required>
            <input id="totp" className="mono" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <button type="submit" disabled={busy} className="btn btn-p">{busy ? 'Checking…' : 'Confirm and turn on'}</button>
        </form>
      ) : (
        <div>
          <p className="u-mb-10">{me.mfa.required && !me.mfa.enrolled ? 'Your role requires two-step verification. Set up an authenticator app, or add a passkey below, to continue.' : 'Add a second step to sign-in for better protection.'}</p>
          <button type="button" onClick={start} disabled={busy} className="btn btn-p">Set up authenticator app</button>
        </div>
      )}
    </Card>
  );
}

/** "Confirm it's you" inline, for a change that needs a recent re-authentication
 * (the Shell's dialog normally handles it first; this is the fallback). */
function ConfirmIdentity({ hasPassword, hasPasskey, onDone, onCancel }: {
  hasPassword: boolean; hasPasskey: boolean; onDone: () => void; onCancel: () => void;
}) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canPasskey = hasPasskey && passkeySupported();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!pw) { setErr('Enter your password.'); return; }
    setBusy(true);
    const r = await post('/api/auth/reauth', { password: pw }).catch(() => null);
    setBusy(false); setPw('');
    if (!r) { setErr('The server could not be reached. Try again.'); return; }
    if (r.status === 403 && r.d.code === 'mfa_required') { setErr('Sign out and sign in again, then add your passkey straight away.'); return; }
    if (!r.ok) { setErr(r.d.error || 'That did not match.'); return; }
    onDone();
  };
  const withPasskey = async () => {
    setErr(null); setBusy(true);
    const ok = await reauthWithPasskey().catch(() => false);
    setBusy(false);
    if (ok) onDone(); else setErr('The passkey was not accepted. Try again, or use your password.');
  };
  return (
    <div className="u-mt-10" role="group" aria-labelledby="pkReauthH">
      <p id="pkReauthH" className="u-mb-10"><b>Confirm it&apos;s you</b> to change how you sign in.</p>
      {err && <Alert kind="error">{err}</Alert>}
      {hasPassword && (
        <form onSubmit={submit} className="u-mw-380">
          <Field label="Your password" htmlFor="pkReauthPw" required>
            <input id="pkReauthPw" type="password" required autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <button type="submit" disabled={busy} className="btn btn-p">Confirm</button>{' '}
          {canPasskey && <button type="button" onClick={withPasskey} disabled={busy} className="btn btn-s">Use a passkey instead</button>}{' '}
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-s">Cancel</button>
        </form>
      )}
      {!hasPassword && (
        <div className="u-row-6">
          {canPasskey
            ? <button type="button" onClick={withPasskey} disabled={busy} className="btn btn-p">Confirm with a passkey</button>
            : <p className="note">Sign out and sign in again to continue.</p>}
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-s">Cancel</button>
        </div>
      )}
    </div>
  );
}

const fmtWhen = (v: string | null) => {
  if (!v) return 'Never';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const backedUp = (p: PasskeyInfo) => (p.backedUp === true ? 'Yes (synced)' : p.backedUp === false ? 'No (this device only)' : 'Unknown');

function Passkeys({ list, loadError, reload }: { list: PasskeyList | null; loadError: string | null; reload: () => Promise<void> }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null);
  const [retry, setRetry] = useState<null | (() => void)>(null);
  useEffect(() => { setSupported(passkeySupported()); }, []);   // browser only: never decided during server rendering

  const fail = (e: unknown, fallback: string, again: () => void) => {
    if (e instanceof PasskeyError && e.code === 'reauth_required') { setRetry(() => again); return; }
    setMsg({ kind: 'error', text: e instanceof Error && e.message ? e.message : fallback });
  };
  const add = async () => {
    setMsg(null);
    const name = label.trim();
    if (!name) { setMsg({ kind: 'error', text: 'Give the passkey a name you will recognise, such as “Work laptop”.' }); return; }
    setBusy(true);
    try {
      await registerPasskey(name);
      setLabel('');
      setMsg({ kind: 'ok', text: `Passkey “${name}” added. You can now sign in with it.` });
      await reload();
    } catch (e) { fail(e, 'The passkey could not be added.', add); }
    finally { setBusy(false); }
  };
  const remove = async (p: PasskeyInfo) => {
    setMsg(null); setBusy(true);
    try {
      await removePasskey(p.id);
      setMsg({ kind: 'ok', text: `Passkey “${p.label}” removed.` });
      await reload();
    } catch (e) { fail(e, 'The passkey could not be removed.', () => remove(p)); }
    finally { setBusy(false); }
  };
  const closeRemove = useCallback(() => setRemoving(null), []);

  const keys = list?.passkeys ?? [];
  const onlyWayIn = keys.length === 1 && list && !list.hasPassword;
  return (
    <Card title="Passkeys">
      <p className="note u-mb-10">A passkey signs you in with your device&apos;s fingerprint, face or PIN instead of a password, and counts as two-step
        verification. Your password{list?.authenticatorApp ? ' and authenticator app' : ''} keep working as other ways to sign in.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {loadError && <Alert kind="error">{loadError}</Alert>}
      {retry && (
        <ConfirmIdentity hasPassword={!!list?.hasPassword} hasPasskey={keys.length > 0}
          onCancel={() => setRetry(null)} onDone={() => { const again = retry; setRetry(null); again(); }} />
      )}
      {list && (
        <Table caption="Your passkeys" colSpan={5} empty={keys.length ? false : 'You have no passkeys yet.'}
          head={<><th scope="col">Name</th><th scope="col">Added</th><th scope="col">Last used</th><th scope="col">Backed up</th><th scope="col"><span className="sr-only">Actions</span></th></>}>
          {keys.map((p) => (
            <tr key={p.id}>
              <td>{p.label}</td>
              <td>{fmtDate(p.createdAt)}</td>
              <td>{fmtWhen(p.lastUsedAt)}</td>
              <td>{backedUp(p)}</td>
              <td><button type="button" className="btn btn-s btn-sm" disabled={busy} onClick={() => { setMsg(null); setRemoving(p); }}
                aria-label={`Remove passkey ${p.label}`}>Remove</button></td>
            </tr>
          ))}
        </Table>
      )}
      {list && !list.available ? (
        <p className="note u-mt-10" role="note">{SIGNIN_UNAVAILABLE_MESSAGE}</p>
      ) : supported === false ? (
        <p className="note u-mt-10" role="note">This browser or device does not support passkeys. You can keep signing in with your password
          {list?.authenticatorApp ? ' and authenticator app' : ''}, or add a passkey from a device that supports them.</p>
      ) : supported && list ? (
        <form className="u-mw-380 u-mt-10" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Field label="Name for the new passkey" htmlFor="pkLabel" required hint="So you can tell your passkeys apart, e.g. “Work laptop” or “Phone”.">
            <input id="pkLabel" required maxLength={60} autoComplete="off" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <button type="submit" disabled={busy} aria-busy={busy} className="btn btn-p">{busy ? 'Waiting for your device…' : 'Add a passkey'}</button>
        </form>
      ) : null}
      <Modal open={!!removing} size="sm" icon="lock" title="Remove this passkey?" onClose={closeRemove}
        footer={<>
          <button type="button" className="btn btn-s" onClick={closeRemove}>Cancel</button>
          <button type="button" className="btn btn-d" disabled={busy}
            onClick={() => { const p = removing; setRemoving(null); if (p) remove(p); }}>Remove passkey</button>
        </>}>
        <p>You will no longer be able to sign in with <b>{removing?.label}</b>. The passkey stays on the device until you delete it there.</p>
        {onlyWayIn && <p className="note u-mt-8">This is your only way to sign in. Set a password or add another passkey first; the system will not
          remove it until then.</p>}
      </Modal>
    </Card>
  );
}

export default function AccountSecurityPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [keys, setKeys] = useState<PasskeyList | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const load = () => fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null));
  const loadKeys = useCallback(async () => {
    try { setKeys(await listPasskeys()); setKeysError(null); }
    catch (e) { setKeysError(e instanceof Error ? e.message : 'Could not load your passkeys.'); }
  }, []);
  useEffect(() => { load(); loadKeys(); }, [loadKeys]);
  const reloadAll = useCallback(async () => { await loadKeys(); load(); }, [loadKeys]);
  return (
    <Shell>
      <div>
        {me?.mustChangePassword && <Alert kind="error">You must change your password before you can use the rest of the system.</Alert>}
        {!me?.mustChangePassword && me?.mfa.enrolmentOutstanding && <Alert kind="error">Your role requires two-step verification. Set up an authenticator app or add a passkey below to continue.</Alert>}
        {me && <ChangePassword forced={me.mustChangePassword} onDone={load} />}
        {me && !me.mustChangePassword && <Authenticator me={me} totpOn={keys ? keys.authenticatorApp : me.mfa.enrolled} refresh={reloadAll} />}
        {me && !me.mustChangePassword && <Passkeys list={keys} loadError={keysError} reload={reloadAll} />}
      </div>
    </Shell>
  );
}
