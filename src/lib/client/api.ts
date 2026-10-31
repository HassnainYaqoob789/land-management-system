'use client';

// The one way screens read and write data.
//
//  - useApi(url): cached GET. Identical requests in flight are shared, a cached
//    answer younger than its TTL is served without a request, and an answer
//    that arrives after the URL changed is dropped (no stale overwrite).
//  - send(method, url, body): a write. On success it invalidates every cached
//    GET under the same API resource (/api/rows → /api/rows?…), and anything
//    listed in `also`, so open screens refetch.
//  - useReference(): lookups, workflow stages and CHECK-constraint values from
//    PostgreSQL (/api/reference), so no screen hard-codes a list.
//
// The cache lives in this browser tab only and holds what this user was
// allowed to read; it is cleared on sign-out and whenever the user's
// permissions, provinces or identity change (clearApiCache, called from
// src/lib/client/permissions.ts). A refetch that is refused (401/403/404)
// drops the data it had, so revoked access never leaves old records on screen.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Reference } from '@/lib/reference';

type Entry = { data?: unknown; error?: string; at: number; promise?: Promise<unknown> };
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => { version++; listeners.forEach((l) => l()); };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

async function readJson(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A CHECK / constraint refusal carries the rule's name; show it so the user knows what to fix.
    const msg = (body?.error || `Request failed (${res.status})`) + (body?.rule ? ` (${String(body.rule).replace(/_/g, ' ')})` : '');
    throw new ApiError(res.status, msg, body?.code);
  }
  return body;
}

function load(url: string): Promise<unknown> {
  const hit = cache.get(url);
  if (hit?.promise) return hit.promise;
  const promise = fetch(url, { headers: { Accept: 'application/json' } }).then(readJson)
    .then((data) => { cache.set(url, { data, at: Date.now() }); return data; })
    .catch((e) => { cache.set(url, { error: e.message, at: Date.now() }); throw e; });
  cache.set(url, { ...hit, at: hit?.at ?? 0, promise });
  return promise;
}

/** Drop cached GETs whose URL starts with any prefix; open screens refetch. */
export function invalidate(...prefixes: string[]) {
  for (const k of [...cache.keys()]) if (prefixes.some((p) => k === p || k.startsWith(p + '?') || k.startsWith(p + '/'))) cache.delete(k);
  bump();
}

export function clearApiCache() { cache.clear(); bump(); }

const resourceOf = (url: string) => {
  const path = url.split('?')[0];
  const m = /^\/api\/[^/]+/.exec(path);
  return m ? m[0] : path;
};

/** A write. Throws ApiError with the server's message; invalidates on success. */
export async function send<T = any>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown,
  opts: { also?: string[] } = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await readJson(res);
  invalidate(resourceOf(url), ...(opts.also ?? []), '/api/analytics', '/api/inbox');
  return data as T;
}

/** A refusal that means "this data is not yours (any more)": never keep showing the old copy. */
const REFUSED = new Set([401, 403, 404]);

/** True when an error from useApi / send is a permission refusal (403 forbidden). */
export function isForbidden(e: { status?: number; code?: string } | null | undefined): boolean {
  return !!e && e.status === 403 && (e.code === undefined || e.code === 'forbidden');
}

export function useApi<T = any>(url: string | null, { ttl = 30_000 }: { ttl?: number } = {}) {
  const v = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version, () => 0);
  // status / code describe the last error (e.g. 403 + 'forbidden'), so a screen can say
  // "you do not have access" instead of showing an empty list.
  const [state, setState] = useState<{ data?: T; error?: string; status?: number; code?: string; loading: boolean }>(() => {
    const hit = url ? cache.get(url) : undefined;
    return { data: hit?.data as T | undefined, loading: !!url && !hit?.data };
  });
  const current = useRef(url);
  current.current = url;

  const run = useCallback((force: boolean) => {
    if (!url) { setState({ loading: false }); return; }
    const hit = cache.get(url);
    if (!force && hit && 'data' in hit && hit.data !== undefined && Date.now() - hit.at < ttl) {
      setState({ data: hit.data as T, loading: false });
      return;
    }
    if (force) cache.delete(url);
    setState((s) => ({ data: s.data, loading: true }));
    load(url).then(
      (data) => { if (current.current === url) setState({ data: data as T, loading: false }); },
      (e) => {
        if (current.current !== url) return;
        const status = e instanceof ApiError ? e.status : undefined;
        const code = e instanceof ApiError ? e.code : undefined;
        // Keep the last good copy only for transient failures (network, 5xx).
        setState((s) => ({ data: status && REFUSED.has(status) ? undefined : s.data, error: e.message, status, code, loading: false }));
      },
    );
  }, [url, ttl]);

  useEffect(() => { run(false); }, [run, v]);
  const reload = useCallback(() => run(true), [run]);
  return { ...state, reload };
}

// ---- reference data ------------------------------------------------------
export function useReference() {
  const { data } = useApi<Reference>('/api/reference', { ttl: 5 * 60_000 });
  return data;
}

/** Stage codes of a workflow in order, without the terminal side-exits (Cancelled / Stopped). */
export function stagesOf(ref: Reference | undefined, workflow: string, { withTerminal = false } = {}): string[] {
  const wf = ref?.workflows[workflow];
  return wf ? wf.stages.filter((s) => withTerminal || !s.terminal).map((s) => s.code) : [];
}

/** The stage that follows `stage`, or null at the end of the line. */
export function nextStage(ref: Reference | undefined, workflow: string, stage: string): string | null {
  const st = stagesOf(ref, workflow);
  const i = st.indexOf(stage);
  return i >= 0 && i < st.length - 1 ? st[i + 1] : null;
}

export function enumOf(ref: Reference | undefined, key: string): string[] {
  return ref?.enums[key] ?? [];
}

export function lookupOf(ref: Reference | undefined, table: string): { code: string; name: string }[] {
  return ref?.lookups[table] ?? [];
}
