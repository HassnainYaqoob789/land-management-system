import { describe, it, expect } from 'vitest';
import { BASE } from '../iam/client';

// Response headers that the browser enforces (next.config.ts, src/middleware.ts).
describe('security headers', () => {
  it('pages carry a nonce-based CSP and anti-framing headers', async () => {
    const a = await fetch(`${BASE}/login`), b = await fetch(`${BASE}/login`);
    const csp = a.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");   // production build
    expect(csp, 'a fresh nonce per response').not.toBe(b.headers.get('content-security-policy'));
    const html = await a.text();
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag, 'every script carries the nonce').toContain(`nonce="${nonce}"`);
    expect(a.headers.get('x-frame-options')).toBe('DENY');
    expect(a.headers.get('x-content-type-options')).toBe('nosniff');
    expect(a.headers.get('referrer-policy')).toBe('same-origin');
    expect(a.headers.get('x-powered-by')).toBeNull();
  });

  it('API responses are not cached and not sniffable', async () => {
    const r = await fetch(`${BASE}/api/auth/me`);
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
