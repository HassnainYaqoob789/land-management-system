// Content-Security-Policy for pages. A fresh nonce per request: Next.js puts it
// on its own scripts when it finds this header on the request, and the root
// layout puts it on theme-init.js. 'strict-dynamic' lets those scripts load the
// chunks they need; nothing inline without the nonce runs.
//
// style-src keeps 'unsafe-inline' because React style={{}} attributes and
// MapLibre's own element styles are inline style attributes (not scripts).
// The GIS basemap tile hosts are the only third parties: OpenStreetMap
// (streets) and Esri World Imagery (satellite), as in the reference.
const TILES = 'https://tile.openstreetmap.org https://server.arcgisonline.com';

export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${TILES}`,
    `font-src 'self' data:`,
    `connect-src 'self' ${TILES}${dev ? ' ws:' : ''}`,
    `worker-src 'self' blob:`,
    `child-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}
