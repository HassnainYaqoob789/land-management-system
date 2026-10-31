'use client';

// Sidebar in the reference's markup (nav.side, .side-brand, .nav-t, .nav-i).
// At <= 980 px it is an off-canvas drawer: while closed it is `inert` (no tab
// stops off-screen, UX-08); the Shell owns opening, closing and focus.

import React, { forwardRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/legacy/ui';
import BrandLogo from '@/components/brand/BrandLogo';
import { NAV, showInMenu } from './nav';

const Sidebar = forwardRef<HTMLElement, { permissions: string[]; provinces?: string[]; roles?: string[]; open: boolean; hidden?: boolean; onNavigate?: () => void }>(
  function Sidebar({ permissions, provinces = [], roles = [], open, hidden = false, onNavigate }, ref) {
    const pathname = usePathname() || '';
    const groups = NAV
      .map(([g, items]) => [g, items.filter((i) => showInMenu(i, permissions, provinces, roles))] as const)
      .filter(([, items]) => items.length);

    return (
      <nav className={`side${open ? ' open' : ''}`} id="side" aria-label="Main" ref={ref} inert={hidden || undefined}>
        <Link className="side-brand" href="/dashboard" onClick={onNavigate}>
          <span className="brand-tile"><BrandLogo variant="mark" size={22} /></span>
          <span><b>Land Management</b><small>Mari Energies Limited</small></span>
        </Link>
        <div>
          {groups.map(([g, items]) => (
            <React.Fragment key={g}>
              <div className="nav-t">{g}</div>
              {items.map((i) => {
                const current = pathname === i.href || pathname.startsWith(i.href + '/');
                return (
                  <Link key={i.href} href={i.href} onClick={onNavigate} className={`nav-i${current ? ' active' : ''}`} aria-current={current ? 'page' : undefined}>
                    <span className="ic" aria-hidden="true"><Icon name={i.icon} size={17} /></span>{i.label}
                  </Link>
                );
              })}
            </React.Fragment>
          ))}
        </div>
        <div className="side-foot">Mari Energies Limited · Land Management System</div>
      </nav>
    );
  });

export default Sidebar;
