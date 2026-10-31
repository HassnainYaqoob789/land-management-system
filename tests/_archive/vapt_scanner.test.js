import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3030';

describe('Vulnerability Assessment & Penetration Testing (VAPT) Scanner', () => {

  // 1. SQL Injection (SQLi) Testing
  describe('VAPT-01: SQL Injection Resilience', () => {
    const sqliPayloads = [
      "' OR '1'='1",
      "'; DROP TABLE lms.project; --",
      "' UNION SELECT null, null, null, null--",
      "1' AND 1=cast((SELECT table_name FROM information_schema.tables LIMIT 1) as int)--",
      "admin'--",
      "\" OR \"\"=\"",
    ];

    it('should resist SQL injection in query parameters across all list endpoints', async () => {
      const endpoints = [
        '/api/cases?province=',
        '/api/cases?stage=',
        '/api/leases?province=',
        '/api/surveys?province=',
        '/api/landowners?province=',
        '/api/landowners?search=',
        '/api/requests?province=',
        '/api/requests?stage=',
        '/api/projects?province=',
      ];

      for (const endpoint of endpoints) {
        for (const payload of sqliPayloads) {
          const url = `${BASE_URL}${endpoint}${encodeURIComponent(payload)}`;
          const res = await fetch(url);
          // Endpoints must either return 200 with clean/empty list or handle gracefully with 400
          assert.ok(
            [200, 400, 404].includes(res.status),
            `Unexpected status ${res.status} on ${url}`
          );

          const bodyText = await res.text();
          // Verify no SQL syntax errors, pg exceptions or stack traces leaked
          assert.doesNotMatch(bodyText, /syntax error at or near/i);
          assert.doesNotMatch(bodyText, /PG::/i);
          assert.doesNotMatch(bodyText, /psycopg2/i);
          assert.doesNotMatch(bodyText, /unterminated quoted string/i);
        }
      }
    });

    it('should resist SQL injection in authentication inputs', async () => {
      for (const payload of sqliPayloads) {
        const res = await fetch(`${BASE_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: payload, password: 'password123' }),
        });

        assert.ok([400, 401, 404].includes(res.status));
        const data = await res.json();
        assert.ok(!data.user, 'SQLi must not bypass authentication');
      }
    });
  });

  // 2. Cross-Site Scripting (XSS) & Header Security
  describe('VAPT-02: Cross-Site Scripting & Injection Sanitization', () => {
    const xssPayloads = [
      "<script>alert('xss')</script>",
      "<img src=x onerror=alert(1)>",
      "<svg onload=alert(document.cookie)>",
      "javascript:alert(1)",
    ];

    it('should sanitize or reject malicious XSS payloads on land requests and case comments', async () => {
      // Login as Admin
      const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin' }),
      });
      const cookie = loginRes.headers.get('set-cookie');

      for (const payload of xssPayloads) {
        // Attempt transition with XSS in comments
        const transRes = await fetch(`${BASE_URL}/api/requests/00000000-0000-0000-0000-000000000001/transition`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie || '',
          },
          body: JSON.stringify({
            action: 'APPROVE',
            comment: payload,
          }),
        });

        // Must handle safely (not crash server)
        assert.ok([200, 400, 404, 500].includes(transRes.status));
        const bodyText = await transRes.text();
        assert.doesNotMatch(bodyText, /<script>alert/i);
      }
    });
  });

  // 3. Broken Object Level Authorization (BOLA / IDOR)
  describe('VAPT-03: Authorization & IDOR Access Control', () => {
    it('should reject unauthenticated workflow decisions on 4-tier land requests', async () => {
      const res = await fetch(`${BASE_URL}/api/requests/any-uuid-here/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'APPROVE', comment: 'Unauthorized approve' }),
      });

      assert.equal(res.status, 401, 'Must reject unauthenticated transition with 401');
    });

    it('should reject unauthenticated lease hold placement', async () => {
      const res = await fetch(`${BASE_URL}/api/leases/any-uuid-here/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'HOLD', reason: 'Disputed Title' }),
      });

      assert.equal(res.status, 401, 'Must reject unauthenticated lease hold with 401');
    });

    it('should reject unauthenticated lease renewal', async () => {
      const res = await fetch(`${BASE_URL}/api/leases/any-uuid-here/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ additional_years: 1 }),
      });

      assert.equal(res.status, 401, 'Must reject unauthenticated lease renewal with 401');
    });
  });

  // 4. Slide 15 Business Logic Security Controls
  describe('VAPT-04: Business Logic & Negative Boundary Constraints', () => {
    it('should block renewal of a lease that is placed on hold', async () => {
      // Login as Admin
      const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin' }),
      });
      const cookie = loginRes.headers.get('set-cookie');

      // Fetch a lease
      const leasesRes = await fetch(`${BASE_URL}/api/leases`);
      const leasesData = await leasesRes.json();
      assert.ok(leasesData.leases.length > 0);
      const testLease = leasesData.leases[0];

      // 1. Place on hold
      const holdRes = await fetch(`${BASE_URL}/api/leases/${testLease.lease_id}/hold`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie || '',
        },
        body: JSON.stringify({
          action: 'HOLD',
          reason: 'Disputed Title / Ownership Conflict: Revenue Court Case 2026-HC',
        }),
      });
      assert.ok([200, 500].includes(holdRes.status));

      // 2. Attempt to renew while on hold - MUST BE BLOCKED
      const renewRes = await fetch(`${BASE_URL}/api/leases/${testLease.lease_id}/renew`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie || '',
        },
        body: JSON.stringify({ additional_years: 1 }),
      });
      assert.equal(renewRes.status, 500);
      const renewData = await renewRes.json();
      assert.ok(renewData.error.toLowerCase().includes('hold'));

      // 3. Release hold to restore clean state
      await fetch(`${BASE_URL}/api/leases/${testLease.lease_id}/hold`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie || '',
        },
        body: JSON.stringify({
          action: 'RELEASE',
          reason: 'Court stay vacated and title certified',
        }),
      });
    });

    it('should require mandatory audit comments for all workflow transitions', async () => {
      const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin' }),
      });
      const cookie = loginRes.headers.get('set-cookie');

      const transRes = await fetch(`${BASE_URL}/api/requests/00000000-0000-0000-0000-000000000001/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie || '',
        },
        body: JSON.stringify({
          action: 'APPROVE',
          comment: '', // Empty comment!
        }),
      });

      assert.equal(transRes.status, 400);
      const data = await transRes.json();
      assert.ok(data.error.toLowerCase().includes('comment'));
    });
  });

  // 5. Corporate SSO Security Verification
  describe('VAPT-05: Single Sign-On (ADFS / Entra ID) Verification', () => {
    it('should expose compliant SAML/OIDC metadata endpoint', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/sso/metadata`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.entity_id, 'https://lms.marienergies.com.pk/auth/saml');
      assert.ok(data.endpoints.assertion_consumer_service);
    });

    it('should authenticate valid enterprise identity via SSO callback', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/sso/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin' }),
      });

      assert.equal(res.status, 200);
      const cookie = res.headers.get('set-cookie');
      assert.ok(cookie && cookie.includes('lms_user_id'));
      assert.ok(cookie.toLowerCase().includes('httponly'));
    });
  });
});
