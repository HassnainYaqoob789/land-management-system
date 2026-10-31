'use client';

// Top-bar global search (UX-05), in the reference's look (legacy-demo
// features.js palette; .search-item classes). An ARIA 1.2 combobox: the input
// owns a listbox of grouped results; Up/Down move through them, Enter opens
// one, Escape closes (and then clears). Ctrl/Cmd+K, or '/' outside a text
// field, focuses it from anywhere. The number of results is announced.
//
// Records come from GET /api/search, which searches only the modules the user
// may read and applies row-level and scope checks; screens come from the menu,
// filtered by the same route permissions the menu uses.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { NAV, routePermissionOf, satisfies, showInMenu } from '@/components/layout/nav';
import { Icon } from '@/components/legacy/ui';
import { dialogOpen } from '@/components/legacy/a11y';

interface Item { id: string; code: string; title: string; sub: string; tag: string | null; href: string }
interface Group { key: string; label: string; items: Item[] }
interface Option extends Item { group: string; optId: string }

const MIN = 2, MAX = 100, PER_GROUP = 5;

/** Menu screens the user may open whose name matches `q`. */
export function screensFor(q: string, permissions: readonly string[]): Item[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < MIN) return [];
  const out: Item[] = [];
  for (const [group, items] of NAV) for (const i of items) {
    const need = routePermissionOf(i.href);
    if ((need && !satisfies(permissions, need)) || !showInMenu(i, permissions)) continue;
    if (`${i.label} ${group}`.toLowerCase().includes(needle))
      out.push({ id: i.href, code: '', title: i.label, sub: group, tag: 'Screen', href: i.href });
  }
  return out.slice(0, PER_GROUP);
}

const typingIn = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
  || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

export default function GlobalSearch({ permissions, activeProvince }: { permissions: string[]; activeProvince: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const listId = `gs-list-${uid}`;
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [cnicNote, setCnicNote] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);   // phones: the field is behind a button
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const term = q.trim();

  // Records from the server, debounced; a newer query cancels an older one.
  useEffect(() => {
    if (term.length < MIN || term.length > MAX) { setGroups([]); setState('idle'); setCnicNote(false); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      setState('loading');
      const qs = new URLSearchParams({ q: term });
      if (activeProvince && activeProvince !== 'ALL') qs.set('province', activeProvince);
      try {
        const res = await fetch(`/api/search?${qs}`, { signal: ctl.signal });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { setGroups([]); setError(body.error || 'Search is not available right now.'); setState('error'); return; }
        setGroups(Array.isArray(body.groups) ? body.groups : []);
        setCnicNote(body.cnic === 'not_permitted');
        setError(''); setState('done');
      } catch (e: any) {
        if (e?.name !== 'AbortError') { setGroups([]); setError('Search is not available right now.'); setState('error'); }
      }
    }, 250);
    return () => { ctl.abort(); window.clearTimeout(t); };
  }, [term, activeProvince]);

  const screens = useMemo(() => screensFor(term, permissions), [term, permissions]);
  const options: Option[] = useMemo(() => {
    const all: Option[] = [];
    const add = (group: string, items: Item[]) => items.forEach((it, i) => all.push({ ...it, group, optId: `${listId}-${group}-${i}` }));
    for (const g of groups) add(g.key, g.items);
    add('screens', screens);
    return all;
  }, [groups, screens, listId]);
  useEffect(() => { setActive(-1); }, [options]);

  const showPanel = open && term.length >= MIN;
  const count = options.length;
  const announce = term.length < MIN ? ''
    : state === 'error' ? error
    : state === 'loading' && !groups.length ? ''
    : count ? `${count} ${count === 1 ? 'result' : 'results'} for ${term}. Use the up and down arrow keys to review them.`
    : state === 'done' ? `No results for ${term}.` : '';

  const go = (o: Option | undefined) => {
    if (!o) return;
    setOpen(false);
    // A full navigation: the list page reads ?q= when it mounts, even if it is the page already open.
    window.location.assign(o.href);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        if (count) setActive((a) => (a + 1) % count);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        if (count) setActive((a) => (a <= 0 ? count - 1 : a - 1));
        break;
      case 'Enter':
        if (showPanel && active >= 0) { e.preventDefault(); go(options[active]); }
        break;
      case 'Escape':
        e.preventDefault();
        if (showPanel) setOpen(false);
        else if (q) setQ('');
        else { setExpanded(false); inputRef.current?.blur(); }
        break;
    }
  };

  // Ctrl/Cmd+K anywhere, '/' when not typing: focus the search.
  const focusSearch = useCallback(() => {
    setExpanded(true);
    window.setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
  }, []);
  useEffect(() => {
    const onDoc = (e: KeyboardEvent) => {
      if (dialogOpen()) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); }
      else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typingIn(document.activeElement)) { e.preventDefault(); focusSearch(); }
    };
    document.addEventListener('keydown', onDoc);
    return () => document.removeEventListener('keydown', onDoc);
  }, [focusSearch]);

  // Leaving the search closes the results (and the phone overlay).
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) { setOpen(false); setExpanded(false); } };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(options[active]?.optId ?? '')?.scrollIntoView({ block: 'nearest' });
  }, [active, options]);

  const label = (key: string) => key === 'screens' ? 'Screens' : groups.find((g) => g.key === key)?.label ?? key;
  const grouped = options.reduce<Record<string, Option[]>>((acc, o) => { (acc[o.group] ||= []).push(o); return acc; }, {});

  return (
    <div className={`top-search gs${expanded ? ' gs-open' : ''}`} role="search" ref={wrapRef}>
      <button type="button" className="ibtn gs-toggle" aria-label="Search records and screens" aria-expanded={expanded}
        onClick={() => (expanded ? setExpanded(false) : focusSearch())}>
        <Icon name="search" />
      </button>
      <div className="gs-field">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          type="text"
          className="gs-input"
          role="combobox"
          aria-label="Search records and screens"
          aria-autocomplete="list"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-activedescendant={showPanel && active >= 0 ? options[active]?.optId : undefined}
          aria-describedby={`${listId}-hint`}
          placeholder="Search khasras, CNIC, leases, cases…"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
        />
        <span className="top-search-kbd" aria-hidden="true"><kbd>/</kbd></span>
      </div>
      <span id={`${listId}-hint`} className="sr-only">Type at least 2 characters. Shortcut: Control K or slash.</span>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
      <div className={`gs-panel${showPanel ? '' : ' gs-hidden'}`}>
        <div role="listbox" id={listId} aria-label="Search results" className="search-results">
          {Object.entries(grouped).map(([key, opts]) => (
            <div role="group" key={key} aria-labelledby={`${listId}-${key}-h`}>
              <div className="search-group-title" id={`${listId}-${key}-h`} role="presentation">{label(key)}</div>
              {opts.map((o) => {
                const i = options.indexOf(o);
                return (
                  <div key={o.optId} id={o.optId} role="option" aria-selected={i === active}
                    className={`search-item${i === active ? ' is-selected' : ''}`}
                    onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => go(o)}>
                    <span className="search-item-main">
                      <span className="search-item-line1">
                        <span className="search-item-title">{o.title}</span>
                        {o.code && <span className="search-item-code">{o.code}</span>}
                        {o.tag && <span className="search-item-tag">{o.tag}</span>}
                      </span>
                      {o.sub && <span className="search-item-line2">{o.sub}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {showPanel && !count && (
          <div className="search-empty" aria-hidden="true">
            <div className="search-empty-title">
              {state === 'loading' ? 'Searching…' : state === 'error' ? error : `No results for “${term}”`}
            </div>
            {state === 'done' && <p>Results come only from registers you have access to{activeProvince !== 'ALL' ? ' in the selected province' : ''}.</p>}
          </div>
        )}
        {showPanel && cnicNote && (
          <p className="gs-note">Searching by CNIC needs permission to view personal data; names and codes were searched.</p>
        )}
        <div className="search-foot" aria-hidden="true">
          <span className="sf-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span className="sf-hint"><kbd>Enter</kbd> open</span>
          <span className="sf-hint"><kbd>Esc</kbd> close</span>
          <span className="grow" />
          <span className="sf-count">{count ? `${count} result${count === 1 ? '' : 's'}` : ''}</span>
        </div>
      </div>
    </div>
  );
}
