// Readable device description from the browser's User-Agent and the
// low-entropy client hints (Sec-CH-UA*) that Chromium browsers send by default.
// No dependency: a short list of patterns covers the browsers people use.

export interface DeviceInfo {
  browser: string;          // e.g. "Chrome 131", "Edge 131", "Safari 17.5"
  os: string;               // e.g. "Windows 10/11", "Android 14", "iOS 17.5"
  type: 'Mobile' | 'Tablet' | 'Desktop' | 'Bot' | 'Unknown';
  summary: string;          // "Chrome 131 on Windows 10/11 (Desktop)"
}

const unq = (s: string | null | undefined) => (s ?? '').replace(/^"|"$/g, '').trim();

function browserOf(ua: string, hint: string | null): string {
  const m = (re: RegExp) => re.exec(ua)?.[1];
  let v: string | undefined;
  if ((v = m(/Edg(?:e|A|iOS)?\/([\d]+)/))) return `Edge ${v}`;
  if ((v = m(/OPR\/([\d]+)/)) || (v = m(/Opera\/([\d]+)/))) return `Opera ${v}`;
  if ((v = m(/SamsungBrowser\/([\d.]+)/))) return `Samsung Internet ${v}`;
  if ((v = m(/YaBrowser\/([\d]+)/))) return `Yandex ${v}`;
  if ((v = m(/Firefox\/([\d]+)/)) || (v = m(/FxiOS\/([\d]+)/))) return `Firefox ${v}`;
  if ((v = m(/CriOS\/([\d]+)/))) return `Chrome ${v}`;
  if ((v = m(/Chrome\/([\d]+)/))) {
    // Brave and others report "Chrome" in the UA but name themselves in the hint.
    const brand = hint ? /"(Brave|Opera|Microsoft Edge|Vivaldi)";v="(\d+)"/.exec(hint) : null;
    return brand ? `${brand[1] === 'Microsoft Edge' ? 'Edge' : brand[1]} ${brand[2]}` : `Chrome ${v}`;
  }
  if (/Safari\//.test(ua) && (v = m(/Version\/([\d.]+)/))) return `Safari ${v}`;
  if ((v = m(/curl\/([\d.]+)/))) return `curl ${v}`;
  if (/node|undici|axios|python-requests|Go-http-client|PostmanRuntime/i.test(ua)) return ua.split(/[\s/]/)[0] || 'Script';
  return 'Unknown browser';
}

function osOf(ua: string, platformHint: string): string {
  const m = (re: RegExp) => re.exec(ua)?.[1];
  let v: string | undefined;
  if (/iPad/.test(ua)) return `iPadOS ${(m(/OS ([\d_]+)/) ?? '').replace(/_/g, '.')}`.trim();
  if (/iPhone|iPod/.test(ua)) return `iOS ${(m(/OS ([\d_]+)/) ?? '').replace(/_/g, '.')}`.trim();
  if ((v = m(/Android ([\d.]+)/))) return `Android ${v}`;
  if (/Android/.test(ua)) return 'Android';
  if ((v = m(/Windows NT ([\d.]+)/))) {
    const names: Record<string, string> = { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.2': 'Windows 8', '6.1': 'Windows 7' };
    return names[v] ?? `Windows NT ${v}`;
  }
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if ((v = m(/Mac OS X ([\d_]+)/))) return `macOS ${v.replace(/_/g, '.')}`;
  if (/Macintosh/.test(ua)) return 'macOS';
  if (/Ubuntu/.test(ua)) return 'Ubuntu Linux';
  if (/Linux/.test(ua)) return 'Linux';
  return platformHint || 'Unknown OS';
}

export function describeDevice(h: { ua: string | null; chUa?: string | null; chMobile?: string | null; chPlatform?: string | null }): DeviceInfo {
  const ua = h.ua ?? '';
  if (!ua) return { browser: 'Unknown browser', os: unq(h.chPlatform) || 'Unknown OS', type: 'Unknown', summary: 'No browser information was sent' };
  const browser = browserOf(ua, h.chUa ?? null);
  const os = osOf(ua, unq(h.chPlatform));
  let type: DeviceInfo['type'];
  if (/bot|crawler|spider|curl|python-requests|Go-http-client|PostmanRuntime|node|undici|axios/i.test(ua)) type = 'Bot';
  else if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) type = 'Tablet';
  else if (h.chMobile === '?1' || /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/.test(ua)) type = 'Mobile';
  else type = 'Desktop';
  return { browser, os, type, summary: `${browser} on ${os} (${type === 'Bot' ? 'script / tool' : type})` };
}

/** The device fields from a request's headers. */
export const deviceFromRequest = (req: Request): DeviceInfo => describeDevice({
  ua: req.headers.get('user-agent'),
  chUa: req.headers.get('sec-ch-ua'),
  chMobile: req.headers.get('sec-ch-ua-mobile'),
  chPlatform: req.headers.get('sec-ch-ua-platform'),
});
