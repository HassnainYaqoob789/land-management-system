'use client';

// Types and small pieces shared by the settings tabs. Everything shown comes
// from the API, which also decides what this user may see; the controls here
// only mirror the permissions the server checks again on every request.

import React from 'react';
import { ApiError } from '@/lib/client/api';

export type Kind = 'oidc' | 'saml' | 'ldap';
export type ProviderStatus = 'available' | 'disabled' | 'untested' | 'test_failed';

export interface ProviderView {
  id: string; name: string; displayName: string; kind: Kind; kindLabel: string; enabled: boolean; status: ProviderStatus;
  runtimeIssue: string | null; lastTestedAt: string | null; lastTestOk: boolean | null; lastTestDetail: string | null;
  lastTestBy: string | null; version: number; updatedAt: string; hasSecret: boolean; secretLabel: string | null;
  config: Record<string, any>; endpoints: Record<string, string>;
}
export interface MappingView {
  id: string; providerId: string; providerName: string; providerDisplayName: string; externalGroup: string;
  roleCode: string | null; roleName: string | null; approvalGroup: string | null; province: string | null; provinceName: string | null;
}
export interface RequestView {
  id: string; providerId: string; providerName: string; providerDisplayName: string; kind: Kind; subject: string; email: string | null;
  displayName: string | null; groups: string[]; status: 'pending' | 'approved' | 'rejected'; requestedAt: string; decidedAt: string | null;
  decidedBy: string | null; note: string | null; username: string | null;
}
export interface PolicyRow { key: string; value: unknown; value_type: string; description: string; updated_at: string }
export interface IdentityData {
  canConfigure: boolean; canDecide: boolean; canSeeAccounts: boolean; origin: string | null;
  builtIn: { local: boolean; passkey: boolean };
  providers: ProviderView[]; mappings: MappingView[];
  roles: { code: string; name: string; status: string; mappable: boolean }[];
  approvalGroups: { code: string; name: string }[]; provinces: { code: string; name: string }[];
  requests: RequestView[]; breakGlass: { username: string; full_name: string; status: string }[];
  policy: PolicyRow[];
}

const STATUS: Record<ProviderStatus, { tone: string; label: string }> = {
  available: { tone: 'g', label: 'Available' },
  disabled: { tone: 'n', label: 'Disabled (tested)' },
  untested: { tone: 'w', label: 'Not tested' },
  test_failed: { tone: 'd', label: 'Test failed' },
};
export function StatusBadge({ status }: { status: ProviderStatus }) {
  const s = STATUS[status];
  return <span className={`b b-${s.tone}`}>{s.label}</span>;
}

export const when = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/** A message for the user from a failed request; a stale re-authentication
 * says what to do rather than looking like a fault. */
export function messageOf(e: unknown): string {
  if (e instanceof ApiError && e.code === 'reauth_required') return 'Please confirm your identity (sign in again or re-authenticate) and retry.';
  return e instanceof Error ? e.message : String(e);
}

/** Success line, announced to screen readers. */
export function Done({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <div className="al i" role="status"><span className="i" /><div className="tx">{children}</div></div>;
}

/** A copyable value (redirect URI, ACS URL …) with its label. */
export function Endpoint({ label, value }: { label: string; value: string }) {
  return (
    <div className="u-mt-6">
      <span className="note">{label}: </span>
      <code className="code" style={{ wordBreak: 'break-all' }}>{value}</code>
    </div>
  );
}
