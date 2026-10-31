'use client';

// Keyboard and screen-reader plumbing shared by every dialog (Modal, the
// province chooser, the re-authentication prompt) and by the shell, in the
// spirit of legacy-demo/assets/js/app/a11y.js:
//
//   useModalLayer — a stack of open dialogs. Only the top one handles Escape
//     and Tab (focus is trapped inside it); everything else on the page,
//     including dialogs underneath, is `inert`. Focus moves in once when the
//     dialog opens and goes back to the opener (or #content) when it closes.
//   RouteAnnouncer — per-route document titles and a polite live region that
//     announces client-side navigations (UX-10). Mounted once, in the root
//     layout, so the live region survives page changes.

import React, { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { navFor } from '@/components/layout/nav';

export const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable, visible elements inside `root`, in tab order (positive tabindex is not used here). */
export function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true');
}

// ---- dialog stack ------------------------------------------------------------

interface Layer { id: number; root: () => HTMLElement | null; escape: () => void }
const layers: Layer[] = [];
let nextId = 1;
const MARK = 'data-modal-inert';
let listening = false;

/** Body children that must stay reachable to assistive technology while a dialog is open. */
const keepLive = (el: Element) => el.tagName === 'NEXT-ROUTE-ANNOUNCER' || el.hasAttribute('data-keep-live')
  || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE';

/** The body child that contains `el` (dialogs are rendered as body children, see Modal). */
function bodyChildOf(el: HTMLElement | null): Element | null {
  let n: Element | null = el;
  while (n && n.parentElement && n.parentElement !== document.body) n = n.parentElement;
  return n && n.parentElement === document.body ? n : null;
}

/** Everything except the top dialog is inert; with no dialog open, nothing we marked stays inert. */
function applyInert() {
  if (typeof document === 'undefined') return;
  const top = layers[layers.length - 1];
  const keep = top ? bodyChildOf(top.root()) : null;
  for (const child of Array.from(document.body.children)) {
    if (top && child !== keep && !keepLive(child)) {
      if (!child.hasAttribute('inert')) { child.setAttribute('inert', ''); child.setAttribute(MARK, ''); }
    } else if (child.hasAttribute(MARK)) {
      child.removeAttribute('inert'); child.removeAttribute(MARK);
    }
  }
}

function onDocKey(e: KeyboardEvent) {
  const top = layers[layers.length - 1];
  if (!top) return;
  const root = top.root();
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    top.escape();
    return;
  }
  if (e.key !== 'Tab' || !root) return;
  const list = focusablesIn(root);
  if (!list.length) { e.preventDefault(); root.focus(); return; }
  const first = list[0], last = list[list.length - 1];
  const at = document.activeElement as HTMLElement | null;
  if (!at || !root.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
}

/** Where focus goes when the opener is gone: the main content, as the reference does. */
function restoreFocus(opener: HTMLElement | null) {
  const target = opener && opener.isConnected && !opener.closest('[inert]') ? opener : document.getElementById('content');
  target?.focus?.({ preventScroll: false });
}

/**
 * Makes `ref` a modal layer while `open`. `onEscape` closes it (omit to ignore
 * Escape, e.g. a choice that must be made). `initialFocus` picks where focus
 * lands on open (default: the first form control, else the first focusable,
 * else the dialog itself). The effect depends on `open` only, so a parent
 * re-render never moves focus (UX-01).
 */
export function useModalLayer(ref: React.RefObject<HTMLElement | null>, open: boolean, onEscape?: () => void,
  initialFocus?: (root: HTMLElement) => HTMLElement | null | undefined) {
  const escRef = useRef(onEscape);
  const focusRef = useRef(initialFocus);
  useEffect(() => { escRef.current = onEscape; focusRef.current = initialFocus; });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const layer: Layer = { id: nextId++, root: () => ref.current, escape: () => escRef.current?.() };
    layers.push(layer);
    if (!listening) { document.addEventListener('keydown', onDocKey, true); listening = true; }
    applyInert();
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      const pick = focusRef.current?.(root)
        ?? root.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])')
        ?? focusablesIn(root).find((el) => !el.classList.contains('x'))
        ?? root;
      pick.focus();
    }
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      applyInert();
      if (!layers.length && listening) { document.removeEventListener('keydown', onDocKey, true); listening = false; }
      // Only the dialog that was on top hands focus back; one closing underneath leaves it alone.
      if (i === layers.length) restoreFocus(opener);
    };
  }, [open, ref]);
}

/** True while any dialog is open (the shell uses it to leave Escape to the dialog). */
export const dialogOpen = () => layers.length > 0;

// ---- route titles and announcements -----------------------------------------

const PUBLIC_TITLES: Record<string, string> = {
  '/login': 'Sign in',
  '/forgot-password': 'Forgot password',
  '/reset-password': 'Reset password',
  '/accept-invitation': 'Accept invitation',
};
export const APP_NAME = 'Mari Energies LMS';

/** The document title for a route: "<page> · Mari Energies LMS". */
export function titleFor(pathname: string): string {
  const p = (pathname || '/').split(/[?#]/)[0];
  const page = navFor(p)?.item.label ?? PUBLIC_TITLES[p.replace(/\/+$/, '') || '/'] ?? null;
  return page ? `${page} · ${APP_NAME}` : `Land Management System · ${APP_NAME}`;
}

/**
 * Sets document.title on every route and announces client-side navigations
 * in a polite live region (the first page load is announced by the browser).
 */
export function RouteAnnouncer() {
  const pathname = usePathname() || '/';
  const [message, setMessage] = useState('');
  const first = useRef(true);
  useEffect(() => {
    const title = titleFor(pathname);
    document.title = title;
    if (first.current) { first.current = false; return; }
    // Cleared first so the same text is announced again on a repeat visit.
    setMessage('');
    const t = window.setTimeout(() => setMessage(`${title.split(' · ')[0]} page`), 150);
    return () => window.clearTimeout(t);
  }, [pathname]);
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-keep-live="" id="routeAnnouncer">{message}</div>;
}
