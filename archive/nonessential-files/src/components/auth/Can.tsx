'use client';

// <Can need="leases:update">…</Can> renders its children only when the
// signed-in user holds the permission(s); otherwise `fallback` (default
// nothing). Hiding a control is a courtesy: the server refuses regardless.

import React from 'react';
import { useCan } from '@/lib/client/permissions';

export function Can({ need, mode = 'all', children, fallback = null }: {
  need: string | string[]; mode?: 'all' | 'any'; children: React.ReactNode; fallback?: React.ReactNode;
}) {
  const can = useCan();
  return <>{can(need, mode) ? children : fallback}</>;
}

export default Can;
