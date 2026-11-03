import { isIP } from 'node:net';

// Approximate location of an IP address (city level), for sign-in alerts.
//   LOGIN_ALERT_GEO=off      no lookup; the address is sent to no one
//   IPINFO_TOKEN=<token>     use ipinfo.io (free tier 50,000 lookups a month)
//   otherwise                use ipwho.is (free, no key)
// Private and local addresses are never looked up. A lookup never throws and
// never takes more than 3 seconds; results are kept in memory for 6 hours.

export interface GeoInfo {
  status: 'found' | 'private' | 'unknown' | 'off' | 'failed';
  city?: string; region?: string; country?: string; countryIso?: string; postal?: string;
  isp?: string; lat?: number; lon?: number; timezone?: string;
  source?: string;
  text: string;              // one line for the e-mail, e.g. "Karachi, Sindh, Pakistan"
}

/** True for loopback, private (RFC 1918), link-local, CGNAT and unique-local addresses. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

const cache = new Map<string, { at: number; geo: GeoInfo }>();
const TTL_MS = 6 * 3600_000;

let regionNames: Intl.DisplayNames | undefined;
/** "PK" -> "Pakistan"; leaves a full name or an unknown code unchanged. */
function countryName(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (v.length !== 2) return v;
  try { regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' }); return regionNames.of(v.toUpperCase()) ?? v; } catch { return v; }
}

const place = (...parts: (string | undefined)[]) => {
  const seen = new Set<string>();
  return parts.filter((p): p is string => !!p && !seen.has(p) && !!seen.add(p)).join(', ');
};

async function getJson(url: string): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`http_${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function locateIp(ip: string | null, env: NodeJS.ProcessEnv = process.env): Promise<GeoInfo> {
  if (!ip || !isIP(ip)) return { status: 'unknown', text: 'Unknown (no address recorded; check TRUST_PROXY_HOPS)' };
  if (isPrivateIp(ip)) return { status: 'private', text: 'Office / local network (private address, no public location)' };
  if ((env.LOGIN_ALERT_GEO ?? '').trim().toLowerCase() === 'off') return { status: 'off', text: 'Not looked up (LOGIN_ALERT_GEO=off)' };

  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.geo;

  let geo: GeoInfo;
  try {
    const token = env.IPINFO_TOKEN?.trim();
    if (token) {
      const j = await getJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`);
      if (j?.bogon) geo = { status: 'private', text: 'Private address, no public location' };
      else {
        const [lat, lon] = String(j?.loc ?? '').split(',').map(Number);
        const country = countryName(j.country);
        geo = { status: 'found', city: j.city, region: j.region, countryIso: j.country, country, postal: j.postal,
          isp: String(j.org ?? '').replace(/^AS\d+\s+/, '') || undefined,
          lat: Number.isFinite(lat) ? lat : undefined, lon: Number.isFinite(lon) ? lon : undefined, timezone: j.timezone,
          source: 'ipinfo.io', text: place(j.city, j.region, country) || 'Unknown' };
      }
    } else {
      const j = await getJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
      if (j?.success === false) geo = { status: 'failed', text: `Lookup failed (${String(j.message ?? 'no answer').slice(0, 60)})` };
      else geo = { status: 'found', city: j.city, region: j.region, country: j.country, countryIso: j.country_code,
        isp: j.connection?.isp || j.connection?.org, lat: j.latitude, lon: j.longitude, timezone: j.timezone?.id,
        source: 'ipwho.is', text: place(j.city, j.region, j.country) || 'Unknown' };
    }
  } catch (e: any) {
    geo = { status: 'failed', text: `Lookup failed (${String(e?.name === 'AbortError' ? 'timeout' : e?.message ?? 'error').slice(0, 40)})` };
  }
  if (geo.status === 'found') {
    cache.set(ip, { at: Date.now(), geo });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return geo;
}
