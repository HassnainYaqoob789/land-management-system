'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Shell, { useLMS } from '@/components/layout/Shell';
import { useApi } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { routePermission, useCan } from '@/lib/client/permissions';
import { Card, Kpi, Stage, Table, Toolbar, SearchBox, Select, Count, Loading, fmtNum, fmtDate, rowOpen, DetailsModal } from '@/components/legacy/ui';

interface CalendarEvent {
  id: string;
  date: string;
  kind: 'Lease Expiry' | 'ROW Renewal' | 'Court Hearing' | 'Land Request';
  code: string;
  title: string;
  province_code: string;
  status: string;
  href: string;
}

export default function CalendarPage() {
  return (
    <Shell>
      <CalendarContent />
    </Shell>
  );
}

function CalendarContent() {
  const { activeProvince } = useLMS();
  const can = useCan();
  /** A link target only when the user can open it (UI-13). */
  const to = (href: string) => { const need = routePermission(href); return !need || can(need) ? href : undefined; };
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [kindFilter, setKindFilter] = useState('');
  const [q, setQ] = useState('');
  const [view, setView] = useState<CalendarEvent | null>(null);
  const [loading, setLoading] = useState(true);

  // Dated events from the database (/api/calendar), within the user's provinces and registers.
  const cal = useApi<any>(`/api/calendar${activeProvince !== 'ALL' ? `?province=${activeProvince}` : ''}`);
  const { data, loading: busy } = cal;
  useEffect(() => {
    if (!data) return;
    setEvents((data.events ?? []).map((e: any) => ({ ...e, date: String(e.date).slice(0, 10) })));
    setLoading(false);
  }, [data]);
  useEffect(() => { if (!busy && !data) setLoading(false); }, [busy, data]);

  const shown = events.filter((ev) => {
    if (kindFilter && ev.kind !== kindFilter) return false;
    if (q && ![ev.code, ev.title, ev.kind, ev.province_code].join(' ').toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <>
      {/* The server lists only the registers the user may read; a tile is shown only for those (UI-09). */}
      {data && (
        <div className="kpis">
          <Kpi label="Scheduled Events" value={fmtNum(events.length)} sub="expiries, renewals & hearings" />
          {can('leases:read') && <Kpi label="Lease Expiries" value={fmtNum(events.filter((e) => e.kind === 'Lease Expiry').length)} sub="surface lease end dates" href={to('/leases')} />}
          {can('legal:read') && <Kpi label="Court Hearings" value={fmtNum(events.filter((e) => e.kind === 'Court Hearing').length)} sub="litigation & stay orders" tone="w" href={to('/legal')} />}
          {can('rows:read') && <Kpi label="ROW Renewals" value={fmtNum(events.filter((e) => e.kind === 'ROW Renewal').length)} sub="corridor rent dates" href={to('/rows')} />}
        </div>
      )}

      <Card
        icon="cal"
        title="Expiry & Hearing Calendar"
        sub="Chronological schedule of surface lease expirations, right-of-way renewals, court hearings, and land request target dates"
      >
        <Toolbar>
          <SearchBox value={q} onChange={setQ} placeholder="Search code, project, court or lessor…" />
          <Select
            label="Event Type"
            value={kindFilter}
            onChange={setKindFilter}
            all="All event types"
            options={['Lease Expiry', 'Court Hearing', 'ROW Renewal', 'Land Request']}
          />
          <Count n={shown.length} />
        </Toolbar>
        <LoadError {...cal} what="the calendar" />
        {loading ? (
          <Loading what="calendar events" />
        ) : cal.error && !data ? null : (
          <Table
            caption="Expiry and hearing schedule"
            head={<><th>Date</th><th>Type</th><th>Code</th><th>Prov.</th><th>Description</th><th>Status</th><th>Action</th></>}
            empty={shown.length ? false : 'No scheduled events match the filter.'}
            colSpan={7}
          >
            {shown.map((ev) => (
              <tr key={ev.id} {...rowOpen(() => setView(ev), `Show ${ev.code}`)}>
                <td className="u-nowrap"><b>{fmtDate(ev.date)}</b></td>
                <td><span className="pill">{ev.kind}</span></td>
                <td><span className="code">{ev.code}</span></td>
                <td><span className="pill">{ev.province_code}</span></td>
                <td>{ev.title}</td>
                <td><Stage value={ev.status} /></td>
                <td>{ev.href && to(ev.href) && <Link className="btn btn-s btn-sm" href={ev.href}>Open</Link>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {view && (() => {
        const days = Math.round((new Date(view.date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
        return (
          <DetailsModal open icon="cal" onClose={() => setView(null)} title={<>{view.kind} <span className="code">{view.code}</span></>}
            sections={[{ items: [
              ['Date', fmtDate(view.date)],
              ['When', Number.isNaN(days) ? null : days === 0 ? 'Today' : days > 0 ? `In ${fmtNum(days)} day(s)` : `${fmtNum(-days)} day(s) ago`],
              ['Type', view.kind], ['Record', <span className="code">{view.code}</span>], ['Province', view.province_code],
              ['Status', <Stage value={view.status} />], ['Description', view.title, true],
            ] }]}
            actions={view.href && to(view.href) ? <Link className="btn btn-s" href={view.href}>Open record</Link> : undefined} />
        );
      })()}
    </>
  );
}

