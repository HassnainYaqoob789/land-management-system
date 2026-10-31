// API load test: signs in as a real user and drives the endpoints the screens
// call, at fixed concurrency, reporting latency percentiles and errors.
//
//   BASE=http://localhost:3043 PERF_PASSWORDS=/path/pw.json node scripts/perf/load_test.mjs [concurrency] [requests]
//
// Point it at a server running against the volume database (db/tools/perf_load.sql),
// never at production. Passwords come from a file, never from source.
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3043';
const PW = JSON.parse(readFileSync(process.env.PERF_PASSWORDS, 'utf8'));
const C = Number(process.argv[2] || 10), N = Number(process.argv[3] || 100);

async function session(user) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ username: user, password: PW[user] }) });
  if (r.status !== 200) throw new Error(`${user} sign-in: ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function run(name, s, make) {
  const times = []; let errors = 0, bytes = 0, i = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: C }, async () => {
    while (i < N) {
      const k = i++;
      const { path, method = 'GET', body } = make(k);
      const t = performance.now();
      const r = await fetch(BASE + path, { method, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: BASE,
        ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const buf = await r.arrayBuffer(); bytes += buf.byteLength;
      times.push(performance.now() - t);
      if (r.status >= 400) errors++;
    }
  }));
  const wall = (performance.now() - t0) / 1000;
  times.sort((a, b) => a - b);
  console.log([name.padEnd(34), `p50 ${pct(times, 50).toFixed(0)}ms`.padEnd(11), `p95 ${pct(times, 95).toFixed(0)}ms`.padEnd(11),
    `p99 ${pct(times, 99).toFixed(0)}ms`.padEnd(12), `${(N / wall).toFixed(1)} req/s`.padEnd(13),
    `avg ${(bytes / N / 1024).toFixed(0)} KB`.padEnd(12), `errors ${errors}`].join(''));
  return { name, p50: pct(times, 50), p95: pct(times, 95), errors };
}

const viewer = await session('viewer');
const lofield = await session('lofield');
console.log(`concurrency ${C}, ${N} requests per endpoint, ${BASE}`);
const GETS = [
  ['dashboard KPIs', '/api/analytics/kpis?role=c_level&unit=Acre'],
  ['cases list (all provinces)', '/api/cases'],
  ['cases list (SND)', '/api/cases?province=SND'],
  ['landowner search', '/api/landowners?q=Ali'],
  ['surveys list', '/api/surveys?province=SND'],
  ['payments list', '/api/payments?province=SND'],
  ['leases list', '/api/leases?province=SND'],
  ['inbox', '/api/inbox'],
  ['report r1 portfolio', '/api/analytics/reports?report=r1&unit=Acre'],
  ['report r5', '/api/analytics/reports?report=r5&unit=Acre'],
  ['audit trail', '/api/audit'],
  ['reference data', '/api/reference'],
];
const results = [];
for (const [name, path] of GETS) results.push(await run(name, viewer, () => ({ path })));

// A write path: idempotent voucher requests (each a different payee period), as the land officer.
const project = (await (await fetch(`${BASE}/api/projects?province=SND`, { headers: { cookie: lofield.cookie } })).json()).projects[0];
const payees = (await (await fetch(`${BASE}/api/landowners?province=SND`, { headers: { cookie: lofield.cookie } })).json()).landowners
  .filter((l) => l.status === 'Active' && !l.is_on_hold).slice(0, 50);
const stamp = Date.now();
// A period no earlier run used, so the duplicate-voucher rule does not (correctly) refuse it.
const periodOf = (k) => new Date(Date.UTC(1950, 0, 1) + ((Math.floor(stamp / 1000) % 500) * 60 + k) * 86400000).toISOString().slice(0, 10);
results.push(await run('payment request (write)', lofield, (k) => ({
  path: '/api/payments', method: 'POST', body: {
    action: 'request', idempotency_key: `perf-${stamp}-${k}-xxxxxxxx`, project_id: project.project_id,
    landowner_id: payees[k % payees.length].id, category: 'Crop Compensation', pay_type: 'One-time', payment_mode: 'Cross Cheque',
    land_class: 'Private', period_from: periodOf(k), gross_amount: 1000 + k,
  },
})));
const failed = results.filter((r) => r.errors);
if (failed.length) { console.log(`errors on: ${failed.map((r) => r.name).join(', ')}`); process.exitCode = 1; }
