// Demo sign-in accounts for the login page — demo environments only.
//
// Shown only when ALL of these hold, so a real deployment can never list them:
//   1. LMS_DEMO_MODE=on in the server environment;
//   2. LMS_DEMO_CREDENTIALS_FILE points at the file scripts/demo/setup_demo.sh
//      wrote (outside git, mode 600);
//   3. the database this server is connected to is the one that file was made
//      for (its passwords exist nowhere else).
// Otherwise the answer is { enabled: false } and nothing else.
import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { withoutActor } from '@/lib/db';

interface DemoAccount { username: string; password: string; fullName: string; position: string; roles: string[]; provinces: string[]; sees: string }
interface DemoFile { database: string; generatedAt: string; accounts: DemoAccount[] }

const NO = () => NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } });

export async function GET() {
  if (process.env.LMS_DEMO_MODE !== 'on') return NO();
  const file = process.env.LMS_DEMO_CREDENTIALS_FILE;
  if (!file) return NO();
  let demo: DemoFile;
  try { demo = JSON.parse(readFileSync(file, 'utf8')); } catch { return NO(); }
  if (!demo || !Array.isArray(demo.accounts) || typeof demo.database !== 'string') return NO();
  try {
    const db = (await withoutActor((c) => c.query('SELECT current_database() AS d'))).rows[0]?.d;
    if (db !== demo.database) return NO();
  } catch { return NO(); }
  return NextResponse.json({
    enabled: true,
    database: demo.database,
    accounts: demo.accounts.map((a) => ({ username: a.username, password: a.password, fullName: a.fullName,
      position: a.position, roles: a.roles, provinces: a.provinces, sees: a.sees })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
