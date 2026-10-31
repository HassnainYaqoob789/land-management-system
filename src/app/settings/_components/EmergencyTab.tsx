'use client';

import React, { useState } from 'react';
import { Card, Field, Table } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import { Done, messageOf, type IdentityData } from './shared';

// Emergency-access ("break-glass") accounts keep a way in when local sign-in is
// off or every provider fails. Each needs MFA and a local password; each use
// raises a security event.
export default function EmergencyTab({ data, reload }: { data: IdentityData; reload: () => void }) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const change = async (name: string, enabled: boolean) => {
    setBusy(name); setError(null); setDone(null);
    try {
      await send('POST', '/api/settings/identity/break-glass', { username: name, enabled });
      setDone(enabled ? `${name} is now an emergency-access account.` : `${name} is no longer an emergency-access account.`);
      if (enabled) setUsername('');
      reload();
    } catch (err) { setError(messageOf(err)); } finally { setBusy(null); }
  };

  return (
    <Card icon="warn" title="Emergency access"
      sub="Needed before local sign-in can be switched off. The account must have MFA enrolled and an active local password.">
      {error && <div className="al d" role="alert"><span className="i" /><div className="tx">{error}</div></div>}
      <Done>{done}</Done>
      {!data.canSeeAccounts ? <p className="note">You need permission to read accounts (users:read) to see these accounts.</p> : (
        <Table caption="Emergency-access accounts" colSpan={3} empty={data.breakGlass.length ? false : 'No emergency-access account is designated.'}
          head={<><th>Account</th><th>Status</th><th><span className="sr-only">Actions</span></th></>}>
          {data.breakGlass.map((u) => (
            <tr key={u.username}>
              <td><b>{u.full_name}</b> <span className="code">{u.username}</span></td>
              <td>{u.status}</td>
              <td>{data.canConfigure && <button type="button" className="btn btn-w btn-sm" disabled={busy !== null}
                onClick={() => change(u.username, false)}>Remove designation</button>}</td>
            </tr>
          ))}
        </Table>
      )}
      {data.canConfigure && (
        <form className="fgrid u-mt-16" onSubmit={(e) => { e.preventDefault(); void change(username.trim().toLowerCase(), true); }}>
          <Field label="Designate an account" required htmlFor="bgUser" hint="Username of a local account with MFA enrolled.">
            <input id="bgUser" required maxLength={64} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <div className="fg bar"><button type="submit" className="btn btn-p" disabled={busy !== null || !username.trim()}>Designate</button></div>
        </form>
      )}
    </Card>
  );
}
