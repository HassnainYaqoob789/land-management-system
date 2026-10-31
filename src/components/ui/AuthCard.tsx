import React from 'react';
import BrandLogo from '@/components/brand/BrandLogo';

// The reference's sign-in surface (legacy-demo/index.html: main.screen >
// .login-card) and form/alert primitives, shared by the unauthenticated pages
// and the account security page.

export function Alert({ kind, children }: { kind: 'error' | 'ok'; children: React.ReactNode }) {
  return (
    <div className={`al ${kind === 'error' ? 'd' : 'i'}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="i" /><div className="tx">{children}</div>
    </div>
  );
}

/** The branded card every signed-out page uses. Auto margins keep a tall card
 * scrollable from its top on short screens instead of clipping it. */
export function AuthPage({ title, sub = 'Land Management System · Mari Energies Limited', back = true, children }: {
  title: string; sub?: React.ReactNode; back?: boolean; children: React.ReactNode;
}) {
  return (
    <main className="screen" id="login">
      <div className="login-card" style={{ marginTop: 'auto', marginBottom: 'auto' }}>
        <div className="u-mb-10"><BrandLogo variant="full" size={88} /></div>
        <h1>{title}</h1>
        <p className="sub">{sub}</p>
        {children}
        {back && <p className="note u-mt-16"><a href="/login">Back to sign in</a></p>}
        <p className="auth-footer" style={{ margin: '18px 0 0', textAlign: 'center', fontSize: 11, color: 'var(--muted, #5a6b7d)' }}>
          © {new Date().getFullYear()} Mari Energies Limited · Developed by Alisons Technology
        </p>
      </div>
    </main>
  );
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-h"><div><h3>{title}</h3></div></div>
      {children}
    </section>
  );
}
