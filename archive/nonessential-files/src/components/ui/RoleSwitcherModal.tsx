'use client';

import React, { useEffect, useState } from 'react';
import { AppUser } from '@/lib/types';

interface RoleSwitcherModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AppUser | null;
  onSwitch: (username: string) => Promise<void>;
}

export default function RoleSwitcherModal({ isOpen, onClose, currentUser }: RoleSwitcherModalProps) {
  const [roles, setRoles] = useState<any[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/users')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.roles) setRoles(d.roles);
      })
      .catch(() => {});
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="modal-bg open" role="dialog" aria-modal="true">
      <div className="modal sm">
        <div className="m-h">
          <div className="t">Active Role Matrix ({currentUser?.username})</div>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="m-b">
          <table className="t">
            <thead>
              <tr>
                <th>Role Code</th>
                <th>Name</th>
                <th>Tier</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.code}>
                  <td className="code">{r.code}</td>
                  <td>{r.name}</td>
                  <td>{r.db_role_code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
