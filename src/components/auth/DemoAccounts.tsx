'use client';
// Demo accounts panel for the sign-in page. Renders nothing unless the server
// says this is a demo environment (see /api/auth/demo-accounts).
import { useEffect, useState } from 'react';

interface Account { username: string; password: string; fullName: string; position: string; roles: string[]; provinces: string[]; sees: string }

export default function DemoAccounts({ onPick }: { onPick: (username: string, password: string) => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/auth/demo-accounts', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => { if (live && d.enabled) setAccounts(d.accounts); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  if (!accounts?.length) return null;
  return (
    <section aria-labelledby="demo-accounts-title" className="demo-accounts"
      style={{ marginTop: 16, border: '1px dashed var(--line, #c9d3df)', borderRadius: 8, padding: 12, fontSize: 13 }}>
      <h2 id="demo-accounts-title" style={{ fontSize: 14, margin: '0 0 4px' }}>Demo environment — sign-in accounts</h2>
      <p style={{ margin: '0 0 8px', color: 'var(--muted, #5a6b7d)' }}>
        Demonstration data only. Each account sees and can do only what its role and provinces allow.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 300, overflowY: 'auto' }}>
        {accounts.map((a) => (
          <li key={a.username} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px', padding: '6px 0',
                                        borderTop: '1px solid var(--line, #e3e8ee)' }}>
            <div>
              <strong>{a.username}</strong> · {a.fullName}
              <div style={{ fontSize: 12 }}>{a.position} · {a.provinces.length === 4 ? 'all provinces' : a.provinces.join(', ') || 'no province'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted, #5a6b7d)' }}>{a.sees}</div>
              <div style={{ fontSize: 12 }}>Password:{' '}
                <code style={{ userSelect: 'none' }}>••••••••••</code>
              </div>
            </div>
            <button type="button" className="btn btn-s" style={{ alignSelf: 'center' }} onClick={() => onPick(a.username, a.password)}
              aria-label={`Use the ${a.username} account`}>Use</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
