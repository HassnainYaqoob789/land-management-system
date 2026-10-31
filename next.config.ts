import type { NextConfig } from "next";

// Headers for every response, API included. The page CSP carries a per-request
// nonce, so it is set in src/middleware.ts rather than here.
const https = (process.env.APP_ORIGIN || '').startsWith('https://');
const security = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(https ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A second build for a test server (e.g. NEXT_DIST_DIR=.next-test) must not overwrite
  // the .next a running server is serving from. Unset: the normal .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // pdfkit reads its standard-font metrics from its own package directory at
  // run time; it must stay a plain Node dependency rather than be bundled.
  serverExternalPackages: ['pdfkit'],
  async headers() {
    return [
      { source: '/:path*', headers: security },
      // The GIS map loads basemap tiles from tile.openstreetmap.org, whose usage
      // policy refuses browser requests without a Referer ("Access blocked" 403).
      // On this page only, send the origin (never the path or query) cross-site.
      // Later entries override earlier ones for the same header key.
      { source: '/gis', headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] },
    ];
  },
};

export default nextConfig;
