'use client';

import React, { useState } from 'react';
import { Card, Field, Modal, Table } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import { Done, Endpoint, messageOf, StatusBadge, when, type IdentityData, type Kind, type ProviderView } from './shared';

type FieldDef = { key: string; label: string; type?: 'text' | 'url' | 'textarea' | 'select' | 'checkbox'; required?: boolean;
  hint?: string; placeholder?: string; options?: [string, string][] };

// What each kind of provider needs. The server validates all of it again.
const FIELDS: Record<Kind, FieldDef[]> = {
  oidc: [
    { key: 'issuer', label: 'Issuer URL', type: 'url', required: true, placeholder: 'https://login.example.com',
      hint: 'Exactly as the provider names itself; its discovery document is read from here. HTTPS only.' },
    { key: 'client_id', label: 'Client ID', required: true },
    { key: 'scopes', label: 'Scopes', placeholder: 'openid email profile', hint: 'Space-separated; openid is always included.' },
    { key: 'groups_claim', label: 'Groups claim', placeholder: 'groups' },
    { key: 'client_auth', label: 'Client authentication', type: 'select',
      options: [['client_secret_basic', 'HTTP Basic (client_secret_basic)'], ['client_secret_post', 'Form post (client_secret_post)']] },
  ],
  saml: [
    { key: 'idp_entity_id', label: 'IdP entity ID', required: true },
    { key: 'sso_url', label: 'IdP single sign-on URL', type: 'url', required: true, hint: 'The HTTP-Redirect endpoint. HTTPS (http only to this machine).' },
    { key: 'idp_certificate', label: 'IdP signing certificate (PEM)', type: 'textarea', required: true },
    { key: 'sp_entity_id', label: 'SP entity ID', hint: 'Leave empty to use this application’s metadata URL.' },
    { key: 'nameid_format', label: 'NameID format', type: 'select', options: [['persistent', 'Persistent'], ['unspecified', 'Unspecified']] },
    { key: 'attr_subject', label: 'Subject attribute', hint: 'Leave empty to identify people by their NameID.' },
    { key: 'attr_email', label: 'E-mail attribute', placeholder: 'email' },
    { key: 'attr_name', label: 'Display-name attribute', placeholder: 'displayName' },
    { key: 'attr_groups', label: 'Groups attribute', placeholder: 'groups' },
    { key: 'require_signed_response', label: 'Also require the whole response to be signed (assertions always are)', type: 'checkbox' },
  ],
  ldap: [
    { key: 'url', label: 'Directory URL', type: 'url', required: true, placeholder: 'ldaps://dc.example.com:636', hint: 'LDAPS only.' },
    { key: 'bind_dn', label: 'Bind DN (service account)', required: true },
    { key: 'base_dn', label: 'Base DN for people', required: true },
    { key: 'user_filter', label: 'User filter', required: true, placeholder: '(sAMAccountName={{username}})',
      hint: 'Must contain {{username}} once; what the person types is escaped.' },
    { key: 'group_attribute', label: 'Group attribute', placeholder: 'memberOf' },
    { key: 'subject_attribute', label: 'Subject attribute (never changes)', placeholder: 'entryUUID', hint: 'objectGUID on Active Directory.' },
    { key: 'email_attribute', label: 'E-mail attribute', placeholder: 'mail' },
    { key: 'name_attribute', label: 'Name attribute', placeholder: 'cn' },
    { key: 'ca_certificate', label: 'CA certificate (PEM)', type: 'textarea',
      hint: 'When set, only this CA is trusted for the directory; empty uses the server’s trust store.' },
  ],
};
const SECRET_LABEL: Record<Kind, string | null> = { oidc: 'Client secret', ldap: 'Bind password', saml: null };
const KIND_LABEL: Record<Kind, string> = { oidc: 'OpenID Connect', saml: 'SAML 2.0', ldap: 'LDAP / Active Directory' };

type Form = { kind: Kind; name: string; displayName: string; config: Record<string, any>; secret: string };

export default function SignInTab({ data, reload }: { data: IdentityData; reload: () => void }) {
  const [edit, setEdit] = useState<{ form: Form; provider: ProviderView | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const can = data.canConfigure;

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key); setError(null); setDone(null);
    try { const msg = await fn(); if (msg) setDone(msg); reload(); }
    catch (e) { setError(messageOf(e)); }
    finally { setBusy(null); }
  };
  const test = (p: ProviderView) => run(`test:${p.id}`, async () => {
    const r = await send('POST', `/api/settings/identity/providers/${p.id}/test`);
    if (!r.ok) throw new Error(`${p.displayName}: test failed — ${r.detail}`);
    return `${p.displayName}: test passed — ${r.detail}`;
  });
  const toggle = (p: ProviderView) => run(`toggle:${p.id}`, async () => {
    await send('PUT', `/api/settings/identity/providers/${p.id}/enabled`, { enabled: !p.enabled });
    return `${p.displayName} is now ${p.enabled ? 'disabled' : 'enabled'}.`;
  });

  return (
    <>
      <Card icon="lock" title="Built-in sign-in methods" sub="Local passwords and passkeys are changed under Security policy and Account & Security">
        <Table caption="Built-in sign-in methods" head={<><th>Method</th><th>Status</th></>}>
          <tr><td>Username and password (local accounts)</td>
            <td>{data.builtIn.local ? <span className="b b-g">On</span> : <span className="b b-n">Off (emergency-access accounts only)</span>}</td></tr>
          <tr><td>Passkeys (device sign-in)</td>
            <td>{data.builtIn.passkey ? <span className="b b-g">Available</span> : <span className="b b-w">Unavailable: the server is not on HTTPS</span>}</td></tr>
        </Table>
      </Card>

      <Card icon="users" title="Organisation sign-in (SSO and directories)"
        sub="A method appears on the sign-in page only after it passes a connection test and is enabled; otherwise it is shown as unavailable."
        actions={can ? <button type="button" className="btn btn-p btn-sm"
          onClick={() => setEdit({ provider: null, form: { kind: 'oidc', name: '', displayName: '', config: {}, secret: '' } })}>+ Add sign-in method</button> : undefined}>
        {error && <div className="al d" role="alert"><span className="i" /><div className="tx">{error}</div></div>}
        <Done>{done}</Done>
        <Table caption="Identity providers" colSpan={4} empty={data.providers.length ? false : 'No identity provider is configured.'}
          head={<><th>Method</th><th>Status</th><th>Last connection test</th><th>Actions</th></>}>
          {data.providers.map((p) => (
            <tr key={p.id}>
              <td>
                <b>{p.displayName}</b> <span className="code">{p.name}</span><br />
                <span className="note">{p.kindLabel}{p.secretLabel ? ` · ${p.secretLabel} ${p.hasSecret ? 'stored' : 'missing'}` : ''}</span>
                {p.endpoints.redirectUri && <Endpoint label="Redirect URI" value={p.endpoints.redirectUri} />}
                {p.endpoints.acsUrl && <><Endpoint label="ACS URL" value={p.endpoints.acsUrl} /><Endpoint label="SP entity ID" value={p.endpoints.spEntityId} /></>}
              </td>
              <td><StatusBadge status={p.status} />{p.runtimeIssue && <p className="note u-mt-6">{p.runtimeIssue}</p>}</td>
              <td>
                {p.lastTestedAt ? <>{when(p.lastTestedAt)}{p.lastTestBy ? ` · ${p.lastTestBy}` : ''}</> : '—'}
                {p.lastTestDetail && <p className="note u-mt-6">{p.lastTestDetail}</p>}
              </td>
              <td>
                <div className="bar u-m-0">
                  {can && <button type="button" className="btn btn-s btn-sm" onClick={() => setEdit({ provider: p,
                    form: { kind: p.kind, name: p.name, displayName: p.displayName, config: { ...p.config }, secret: '' } })}>Edit</button>}
                  {can && <button type="button" className="btn btn-s btn-sm" disabled={busy !== null} aria-busy={busy === `test:${p.id}`}
                    onClick={() => test(p)}>{busy === `test:${p.id}` ? 'Testing…' : 'Test connection'}</button>}
                  {can && <button type="button" className={`btn btn-sm ${p.enabled ? 'btn-w' : 'btn-g'}`} disabled={busy !== null || (!p.enabled && p.status !== 'disabled')}
                    title={!p.enabled && p.status !== 'disabled' ? 'Pass a connection test first' : undefined}
                    onClick={() => toggle(p)}>{p.enabled ? 'Disable' : 'Enable'}</button>}
                  {p.kind === 'saml' && <a className="btn btn-s btn-sm" href={`/api/settings/identity/providers/${p.id}/metadata`} download>SP metadata</a>}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {edit && <ProviderModal provider={edit.provider} initial={edit.form} onClose={() => setEdit(null)}
        onSaved={(msg) => { setEdit(null); setDone(msg); setError(null); reload(); }} />}
    </>
  );
}

function ProviderModal({ provider, initial, onClose, onSaved }: {
  provider: ProviderView | null; initial: Form; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creating = !provider;
  const secretLabel = SECRET_LABEL[form.kind];
  const setConfig = (k: string, v: unknown) => setForm((f) => ({ ...f, config: { ...f.config, [k]: v } }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    // Only this kind's fields; empty strings become "use the default".
    const config = Object.fromEntries(FIELDS[form.kind].map((f) => [f.key, f.type === 'checkbox' ? !!form.config[f.key] : (form.config[f.key] ?? '')]));
    const body = { displayName: form.displayName, config, ...(form.secret ? { secret: form.secret } : {}) };
    try {
      if (creating) {
        await send('POST', '/api/settings/identity/providers', { kind: form.kind, name: form.name, ...body });
        onSaved(`${form.displayName} saved. Run “Test connection”, then enable it.`);
      } else {
        const r = await send('PUT', `/api/settings/identity/providers/${provider.id}`, body);
        onSaved(r.retestRequired ? `${form.displayName} saved and disabled until it passes a new connection test.` : `${form.displayName} saved.`);
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  };

  const fid = (k: string) => `idp-${k}`;
  return (
    <Modal open size="lg" icon="lock" title={creating ? 'Add sign-in method' : `Edit ${provider.displayName}`} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="idpForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <form id="idpForm" onSubmit={save} className="fgrid" autoComplete="off">
        {!creating && <p className="note full">Changing these settings or the secret disables the method until it passes a new connection test.</p>}
        <Field label="Type" required htmlFor={fid('kind')}>
          <select id={fid('kind')} value={form.kind} disabled={!creating}
            onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as Kind, config: {}, secret: '' }))}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Name" required htmlFor={fid('name')} hint="Lower-case letters, digits and hyphens; part of the sign-in URLs and fixed once saved.">
          <input id={fid('name')} required value={form.name} disabled={!creating} pattern="[a-z][a-z0-9\-]{1,30}" maxLength={31}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.trim().toLowerCase() }))} />
        </Field>
        <Field label="Button label" required htmlFor={fid('display')} hint="Shown as “Sign in with …”.">
          <input id={fid('display')} required maxLength={80} value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
        </Field>
        {secretLabel && (
          <Field label={secretLabel} required={creating} htmlFor={fid('secret')}
            hint={provider?.hasSecret ? 'Stored encrypted and never shown. Leave empty to keep it; type a new one to replace it.' : 'Stored encrypted and never shown again.'}>
            <input id={fid('secret')} type="password" autoComplete="new-password" required={creating} value={form.secret}
              placeholder={provider?.hasSecret ? '•••••••• (stored)' : ''} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} />
          </Field>
        )}
        {FIELDS[form.kind].map((f) => (
          f.type === 'checkbox' ? (
            <div className="fg full" key={f.key}>
              <label htmlFor={fid(f.key)}><input id={fid(f.key)} type="checkbox" checked={!!form.config[f.key]}
                onChange={(e) => setConfig(f.key, e.target.checked)} /> {f.label}</label>
            </div>
          ) : (
            <Field key={f.key} label={f.label} required={f.required} hint={f.hint} htmlFor={fid(f.key)} full={f.type === 'textarea'}>
              {f.type === 'select' ? (
                <select id={fid(f.key)} value={form.config[f.key] ?? f.options![0][0]} onChange={(e) => setConfig(f.key, e.target.value)}>
                  {f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea id={fid(f.key)} required={f.required} className="mono" rows={6} spellCheck={false} value={form.config[f.key] ?? ''}
                  placeholder="-----BEGIN CERTIFICATE-----" onChange={(e) => setConfig(f.key, e.target.value)} />
              ) : (
                <input id={fid(f.key)} type={f.type === 'url' ? 'url' : 'text'} required={f.required} spellCheck={false} value={form.config[f.key] ?? ''}
                  placeholder={f.placeholder} onChange={(e) => setConfig(f.key, e.target.value)} />
              )}
            </Field>
          )
        ))}
      </form>
    </Modal>
  );
}
