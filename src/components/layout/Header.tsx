'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppUser } from '@/lib/types';
import { Icon } from '@/components/legacy/ui';
import BrandLogo from '@/components/brand/BrandLogo';
import { clearApiCache } from '@/lib/client/api';
import { PROVINCES } from './nav';

interface HeaderProps {
  title: string;
  sub: string;
  currentUser: AppUser | null;
  roleName: string;
  permissions: string[];
  activeProvince: string;
  onChooseProvince: () => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  burgerRef?: React.Ref<HTMLButtonElement>;
  /** Rendered between the title and the province chip (the global search). */
  search?: React.ReactNode;
}

function currentTheme(): 'light' | 'dark' {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * What the bell counts: the signed-in user's own unread notifications plus the
 * open approvals waiting on their approval positions (UI-10). Rows addressed to
 * anyone else are never counted, whatever the server returned.
 */
export function inboxCountFor(body: any, userId: string | undefined): number {
  if (!body || !userId) return 0;
  const unread = (body.notifications || []).filter((n: any) => n && n.user_id === userId && !n.read_at).length;
  const waiting = Number.isFinite(Number(body.mine_total)) ? Number(body.mine_total) : (body.mine || []).length;
  return unread + waiting;
}

export default function Header({
  title,
  sub,
  currentUser,
  roleName,
  permissions,
  activeProvince,
  onChooseProvince,
  drawerOpen,
  onToggleDrawer,
  burgerRef,
  search,
}: HeaderProps) {
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [inboxCount, setInboxCount] = useState<number>(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const canInbox = permissions.includes('inbox:read');
  const userId = currentUser?.id;

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  // The bell: only for users who may open the inbox, and only their own items.
  useEffect(() => {
    if (!canInbox || !userId) { setInboxCount(0); return; }
    let active = true;
    const qs = activeProvince && activeProvince !== 'ALL' ? `?province=${encodeURIComponent(activeProvince)}` : '';
    fetch(`/api/inbox${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (active) setInboxCount(inboxCountFor(d, userId)); })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [activeProvince, canInbox, userId]);

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const closeMenu = useCallback((refocus: boolean) => {
    setMenu(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Opening moves focus to the first item; a click outside closes the menu.
  useEffect(() => {
    if (!menu) return;
    items()[0]?.focus();
    const outside = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [menu]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': go(at + 1); break;
      case 'ArrowUp': go(at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(list.length - 1); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); closeMenu(true); break;
      case 'Tab': e.preventDefault(); closeMenu(true); break;
    }
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setMenu(true); }
    else if (e.key === 'Escape' && menu) { e.preventDefault(); setMenu(false); }
  };

  const toggleTheme = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('lms_theme', next);
    } catch {
      /* not persisted */
    }
    setTheme(next);
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      try {
        sessionStorage.removeItem('lms_ctx');
      } catch {
        /* ignore */
      }
      clearApiCache(); // the next person at this browser must not see this user's cached data
      window.location.href = '/login';
    }
  };

  const p = PROVINCES[activeProvince];
  const provName = activeProvince === 'ALL' ? 'All provinces' : p?.name ?? activeProvince;
  const name = currentUser?.full_name || currentUser?.username || '';
  // Two initials (first and last name) identify the account better than one.
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  const initial = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  const bellLabel = inboxCount > 0
    ? `Approvals and alerts, ${inboxCount > 99 ? 'more than 99' : inboxCount} waiting for you`
    : 'Approvals and alerts';

  return (
    <header className="top">
      <button
        type="button"
        className="burger"
        aria-label={drawerOpen ? 'Hide navigation' : 'Show navigation'}
        aria-expanded={drawerOpen}
        aria-controls="side"
        onClick={onToggleDrawer}
        ref={burgerRef}
      >
        <Icon name="menu" size={18} />
      </button>
      {/* The sidebar carries the logo where it is docked; elsewhere the header does. */}
      <span className="top-brand"><BrandLogo variant="mark" size={20} /></span>
      <div className="ttl">
        <h1>{title}</h1>
        <small>{sub}</small>
      </div>
      {search}
      <span className="sp" />
      <span className="chip is-static hide-m">
        <span className="status-pulse-dot" />
        PAKISTAN E&amp;P
      </span>
      <button
        type="button"
        className="chip"
        id="provChip"
        onClick={onChooseProvince}
        title="Change province"
        aria-label={`Province: ${provName} — change`}
      >
        <span className="dot" aria-hidden="true" />
        <span className="prov-long">{provName} <span aria-hidden="true">▾</span></span>
        {/* Phones: a short code instead of a bare colour dot. */}
        <span className="prov-short" aria-hidden="true">{activeProvince === 'ALL' ? 'All' : activeProvince}</span>
      </button>
      {canInbox && (
        <div className="u-rel-inline">
          <a href="/inbox" className="ibtn" title="Approvals and alerts" aria-label={bellLabel}>
            <Icon name="bell" />
          </a>
          {inboxCount > 0 && (
            <span className="bell-n" aria-hidden="true">{inboxCount > 99 ? '99+' : inboxCount}</span>
          )}
        </div>
      )}
      <button type="button" className="ibtn hide-m" onClick={toggleTheme} title="Dark / light mode"
        aria-label="Toggle dark mode" aria-pressed={theme === 'dark'}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <div className="user-wrap" ref={wrapRef}>
        <button
          type="button"
          className="user"
          ref={triggerRef}
          id="uMenuBtn"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-controls={menu ? 'uMenu' : undefined}
          aria-label={`Account menu: ${name || 'signed-in user'}${roleName ? `, ${roleName}` : ''}`}
          onClick={() => setMenu((m) => !m)}
          onKeyDown={onTriggerKey}
        >
          <span className="avatar" aria-hidden="true">{initial}</span>
          <span className="hide-m" aria-hidden="true">
            <span className="n">{currentUser?.full_name ?? ''}</span>
            <span className="r">{roleName}</span>
          </span>
        </button>
        {menu && (
          <div className="menu" id="uMenu" role="menu" aria-labelledby="uMenuBtn" ref={menuRef} onKeyDown={onMenuKey}>
            <div className="info" role="presentation">
              <b>{currentUser?.full_name}</b>
              <br />
              {currentUser?.username}
              {currentUser?.position ? ` · ${currentUser.position}` : ''}
            </div>
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setMenu(false); onChooseProvince(); }}>
              <span className="m-ic" aria-hidden="true"><Icon name="map" size={15} /></span>
              Change province
            </button>
            <button type="button" role="menuitem" tabIndex={-1} onClick={toggleTheme}>
              <span className="m-ic" aria-hidden="true"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /></span>
              {theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            </button>
            {canInbox && (
              <a role="menuitem" tabIndex={-1} href="/inbox">
                <span className="m-ic" aria-hidden="true"><Icon name="bell" size={15} /></span>
                Approvals &amp; Notifications
              </a>
            )}
            <a role="menuitem" tabIndex={-1} href="/account/security">
              <span className="m-ic" aria-hidden="true"><Icon name="lock" size={15} /></span>
              Account &amp; security
            </a>
            <button type="button" role="menuitem" tabIndex={-1} onClick={logout}>
              <span className="m-ic" aria-hidden="true"><Icon name="logout" size={15} /></span>
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
