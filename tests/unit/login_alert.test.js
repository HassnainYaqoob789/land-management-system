import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeDevice } from '../../src/lib/iam/device.ts';
import { isPrivateIp, locateIp } from '../../src/lib/iam/geoip.ts';

// Sign-in alert helpers (src/lib/iam/device.ts, geoip.ts).
describe('describeDevice', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Chrome 131', 'Windows 10/11', 'Desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'Edge 131', 'Windows 10/11', 'Desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari 17.5', 'iOS 17.5', 'Mobile'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome 130', 'Android 14', 'Mobile'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome 130', 'Android 13', 'Tablet'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox 132', 'macOS 10.15.7', 'Desktop'],
    ['curl/8.4.0', 'curl 8.4.0', 'Unknown OS', 'Bot'],
  ];
  for (const [ua, browser, os, type] of cases) {
    it(`${browser} / ${os}`, () => {
      const d = describeDevice({ ua });
      assert.equal(d.browser, browser); assert.equal(d.os, os); assert.equal(d.type, type);
      assert.ok(d.summary.includes(browser));
    });
  }
  it('uses the client hint brand (Brave reports Chrome in the UA)', () => {
    const d = describeDevice({ ua: cases[0][0], chUa: '"Brave";v="131", "Chromium";v="131", "Not_A Brand";v="24"' });
    assert.equal(d.browser, 'Brave 131');
  });
  it('no user agent', () => assert.equal(describeDevice({ ua: null }).type, 'Unknown'));
});

describe('geoip', () => {
  it('private addresses', () => {
    for (const ip of ['10.1.2.3', '192.168.1.50', '172.20.0.1', '127.0.0.1', '100.64.1.1', '::1', 'fd00::1']) assert.equal(isPrivateIp(ip), true, ip);
    for (const ip of ['39.32.10.1', '8.8.8.8', '172.32.0.1', '2400:adc0::1']) assert.equal(isPrivateIp(ip), false, ip);
  });
  it('no network call for private, missing or switched-off lookups', async () => {
    assert.equal((await locateIp('192.168.1.5')).status, 'private');
    assert.equal((await locateIp(null)).status, 'unknown');
    assert.equal((await locateIp('8.8.8.8', { LOGIN_ALERT_GEO: 'off' })).status, 'off');
  });
});
