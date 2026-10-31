'use client';

// Talking to /api/reports/* (src/lib/reporting/types.ts is the contract).
//  - useReportRun(config): POST /api/reports/run whenever the config changes.
//    The previous request is aborted and a late answer is dropped, so a slow
//    earlier run can never overwrite a newer one. Errors and refusals are
//    states of their own; an error is never shown as "no data".
//  - exportReport / printReport: the server renders every file and the print
//    view from the same engine output as the screen.

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/client/api';
import { onForbidden } from '@/lib/client/permissions';
import type { ExportFormat, ReportConfig, ReportResult } from '@/lib/reporting/types';

export class ReportError extends ApiError {
  constructor(status: number, message: string, code?: string, public correlationId?: string) { super(status, message, code); }
}

async function errorOf(res: Response): Promise<ReportError> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  const msg = typeof body?.error === 'string' && body.error ? body.error
    : res.status === 403 ? 'You do not have permission to do this.'
      : res.status === 401 ? 'Your session has ended. Sign in again.'
        : `The server could not complete the request (${res.status}).`;
  if (res.status === 403 && (body?.code === undefined || body?.code === 'forbidden')) onForbidden();
  return new ReportError(res.status, msg, typeof body?.code === 'string' ? body.code : undefined,
    typeof body?.correlationId === 'string' ? body.correlationId : undefined);
}

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ReportError(0, 'The server could not be reached. Check your connection and try again.');
  }
  if (!res.ok) throw await errorOf(res);
  return res.json() as Promise<T>;
}

export type RunState =
  | { status: 'idle' }
  | { status: 'loading'; previous?: ReportResult }
  | { status: 'ok'; result: ReportResult }
  | { status: 'denied'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string; correlationId?: string };

/** Runs `config` (null = nothing to run). `key` must change whenever the config does. */
export function useReportRun(config: ReportConfig | null, key: string): RunState & { retry: () => void } {
  const [state, setState] = useState<RunState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const last = useRef<ReportResult | undefined>(undefined);

  useEffect(() => {
    if (!config) { setState({ status: 'idle' }); return; }
    const my = ++seq.current;
    const ctl = new AbortController();
    setState({ status: 'loading', previous: last.current });
    postJson<ReportResult>('/api/reports/run', { config }, ctl.signal).then(
      (result) => {
        if (my !== seq.current) return;
        last.current = result;
        setState({ status: 'ok', result });
      },
      (e) => {
        if (my !== seq.current || (e as Error)?.name === 'AbortError') return;
        last.current = undefined;
        const err = e as ReportError;
        if (err.status === 403 || err.status === 401) setState({ status: 'denied', message: err.message });
        else if (err.status === 400) setState({ status: 'invalid', message: err.message });
        else setState({ status: 'error', message: err.message || 'The report could not be run.', correlationId: err.correlationId });
      },
    );
    return () => ctl.abort();
    // `key` stands for the config's content (a new object with the same content does not re-run).
  }, [key, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/** The config the exports and the print view receive: the applied one, without the screen's page. */
export function exportConfig(config: ReportConfig): ReportConfig {
  const { page: _page, ...rest } = config;
  return rest;
}

function fileNameOf(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return (plain?.[1] ?? fallback).replace(/[\\/]/g, '_');
}

async function exportResponse(config: ReportConfig, format: ExportFormat, title: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch('/api/reports/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: exportConfig(config), format, title }),
    });
  } catch {
    throw new ReportError(0, 'The server could not be reached. Check your connection and try again.');
  }
  if (!res.ok) throw await errorOf(res);
  return res;
}

/** Download the report as a file (PDF, Excel or CSV) rendered by the server. */
export async function exportReport(config: ReportConfig, format: Exclude<ExportFormat, 'html'>, title: string): Promise<string> {
  const res = await exportResponse(config, format, title);
  const blob = await res.blob();
  const name = fileNameOf(res, `report.${format}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
}

/**
 * Print: the server's print view (logo, filters, scope, unit, page numbers)
 * in a new window, then the browser's print dialog. The window is opened
 * during the click so pop-up blockers allow it, and filled when the file
 * arrives. The view is the engine's escaped HTML and carries no scripts.
 */
export async function printReport(config: ReportConfig, title: string): Promise<void> {
  const w = window.open('', '_blank');
  if (!w) throw new ReportError(0, 'The print window was blocked. Allow pop-ups for this site and try again.');
  try {
    w.document.title = 'Preparing report…';
    w.document.body.textContent = 'Preparing the print view…';
  } catch { /* a browser that refuses access still gets the document below */ }
  try {
    const res = await exportResponse(config, 'html', title);
    const html = await res.text();
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* the user can print from the window */ } }, 300);
  } catch (e) {
    w.close();
    throw e;
  }
}
