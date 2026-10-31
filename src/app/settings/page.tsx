'use client';

import React, { useEffect, useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Loading, Tabs } from '@/components/legacy/ui';
import { useApi } from '@/lib/client/api';
import { useCan } from '@/lib/client/permissions';
import { LoadError } from '@/components/auth/PageGuard';
import GeneralTab from './_components/GeneralTab';
import PolicyTab from './_components/PolicyTab';
import SignInTab from './_components/SignInTab';
import MappingsTab from './_components/MappingsTab';
import RequestsTab from './_components/RequestsTab';
import EmergencyTab from './_components/EmergencyTab';
import type { IdentityData } from './_components/shared';

export default function SettingsPage() {
  return (
    <Shell>
      <SettingsContent />
    </Shell>
  );
}

type Tab = 'general' | 'policy' | 'signin' | 'mappings' | 'requests' | 'emergency';
const TABS: Tab[] = ['general', 'policy', 'signin', 'mappings', 'requests', 'emergency'];

// System settings for every settings reader; identity and security policy,
// sign-in methods, group mappings, access requests and emergency access only
// for identity_settings:read (UI-11). The server applies the same rules to
// every request; these checks only decide what is worth showing.
function SettingsContent() {
  const can = useCan();
  const identity = can('identity_settings:read');
  const general = useApi<any>('/api/settings');
  const idApi = useApi<IdentityData>(identity ? '/api/settings/identity' : null);
  const id = idApi.data;
  const pending = id?.requests.filter((r) => r.status === 'pending').length ?? 0;

  const available: [Tab, React.ReactNode][] = [['general', 'General']];
  if (identity) {
    available.push(['policy', 'Security policy'], ['signin', 'Sign-in methods'], ['mappings', 'Group mappings']);
    if (id?.canDecide) available.push(['requests', pending ? `Access requests (${pending})` : 'Access requests']);
    available.push(['emergency', 'Emergency access']);
  }
  const [tab, setTab] = useState<Tab>('general');
  // Remember the section in the address (#signin …) so it can be linked to.
  useEffect(() => {
    const h = window.location.hash.slice(1) as Tab;
    if (TABS.includes(h)) setTab(h);
  }, []);
  const choose = (t: Tab) => { setTab(t); try { history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } };
  const shown: Tab = available.some(([t]) => t === tab) ? tab : 'general';

  const identityBody = (body: (d: IdentityData) => React.ReactNode) =>
    idApi.error ? <LoadError error={idApi.error} what="identity settings" />
      : !id ? <Loading what="identity settings" /> : body(id);

  return (
    <>
      <Tabs<Tab> tabs={available} value={shown} onChange={choose} label="Settings sections" />
      <div role="tabpanel" aria-label={String(available.find(([t]) => t === shown)?.[1] ?? 'General')} className="u-mt-12">
        {shown === 'general' && (general.error ? <LoadError error={general.error} what="system settings" />
          : !general.data ? <Loading what="system settings" />
          : <GeneralTab data={general.data} canUpdate={can('settings:update')} reload={general.reload} />)}
        {shown === 'policy' && identityBody((d) => <PolicyTab data={d} reload={idApi.reload} />)}
        {shown === 'signin' && identityBody((d) => <SignInTab data={d} reload={idApi.reload} />)}
        {shown === 'mappings' && identityBody((d) => <MappingsTab data={d} reload={idApi.reload} />)}
        {shown === 'requests' && identityBody((d) => <RequestsTab data={d} reload={idApi.reload} />)}
        {shown === 'emergency' && identityBody((d) => <EmergencyTab data={d} reload={idApi.reload} />)}
      </div>
    </>
  );
}
