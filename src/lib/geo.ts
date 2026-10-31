// Plane geometry for land-request polygons, shared by the browser (live area,
// parcels inside, warnings while drawing) and the server (which recomputes all
// of it and never trusts the figures a client sends). Coordinates are WGS84
// [longitude, latitude] degrees, as in GeoJSON. Pure functions, no imports, so
// this file is safe in both bundles.

export type LngLat = [number, number];

// WGS84 ellipsoid.
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** Square metres per acre (exact SI definition; the same factor as lms.unit_conversion). */
export const SQM_PER_ACRE = 4046.8564224;
export const SQM_PER_HECTARE = 10000;

/** Corners without the closing repeat. */
export function openRing(ring: LngLat[]): LngLat[] {
  if (ring.length > 1 && sameLngLat(ring[0], ring[ring.length - 1])) return ring.slice(0, -1);
  return ring.slice();
}

/** Corners with the first repeated at the end (GeoJSON). */
export function closeRing(ring: LngLat[]): LngLat[] {
  const open = openRing(ring);
  return open.length ? [...open, [open[0][0], open[0][1]]] : [];
}

function sameLngLat(a: LngLat, b: LngLat) { return a[0] === b[0] && a[1] === b[1]; }

/**
 * Area of a ring in square metres: every corner is projected onto the plane
 * tangent to the WGS84 ellipsoid at the ring's mean point, then the shoelace
 * formula. Accurate to well under 0.1% for parcels and blocks up to tens of
 * kilometres across (the method of src/lib/kml.ts, UOM-10).
 */
export function polygonAreaSqm(ring: LngLat[]): number {
  const pts = openRing(ring);
  if (pts.length < 3) return 0;
  const rad = Math.PI / 180;
  const lat0 = (pts.reduce((s, p) => s + p[1], 0) / pts.length) * rad;
  const lng0 = (pts.reduce((s, p) => s + p[0], 0) / pts.length) * rad;
  const s2 = Math.sin(lat0) ** 2;
  const m = (WGS84_A * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * s2, 1.5);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s2);
  const xy = pts.map(([lng, lat]) => [(lng * rad - lng0) * n * Math.cos(lat0), (lat * rad - lat0) * m]);
  let twice = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice / 2);
}

/** Centre of the shape (area-weighted; the mean of the corners for a degenerate ring). */
export function centroid(ring: LngLat[]): LngLat {
  const pts = openRing(ring);
  if (!pts.length) return [0, 0];
  // Relative to the first corner: large absolute degrees lose precision in the cross products.
  const [ox, oy] = pts[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const x1 = pts[i][0] - ox, y1 = pts[i][1] - oy;
    const x2 = pts[(i + 1) % pts.length][0] - ox, y2 = pts[(i + 1) % pts.length][1] - oy;
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-15) {
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }
  return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

/** Whether a point lies inside a ring (ray casting; points on an edge may go either way). */
export function pointInRing(pt: LngLat, ring: LngLat[]): boolean {
  const pts = openRing(ring);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orient(a: LngLat, b: LngLat, c: LngLat) {
  const v = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  return Math.abs(v) < 1e-18 ? 0 : v > 0 ? 1 : 2;
}
function onSeg(a: LngLat, b: LngLat, c: LngLat) {
  return b[0] <= Math.max(a[0], c[0]) && b[0] >= Math.min(a[0], c[0]) && b[1] <= Math.max(a[1], c[1]) && b[1] >= Math.min(a[1], c[1]);
}
/** Whether segments p1-q1 and p2-q2 cross or touch. */
export function segmentsIntersect(p1: LngLat, q1: LngLat, p2: LngLat, q2: LngLat): boolean {
  const o1 = orient(p1, q1, p2), o2 = orient(p1, q1, q2), o3 = orient(p2, q2, p1), o4 = orient(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(p1, p2, q1)) return true;
  if (o2 === 0 && onSeg(p1, q2, q1)) return true;
  if (o3 === 0 && onSeg(p2, p1, q2)) return true;
  if (o4 === 0 && onSeg(p2, q1, q2)) return true;
  return false;
}

/** Whether any two non-adjacent edges of the ring cross (a "bow-tie"). */
export function ringSelfIntersects(ring: LngLat[]): boolean {
  const pts = openRing(ring);
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i], a2 = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;   // adjacent edges share a corner
      if (segmentsIntersect(a1, a2, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Whether two rings share any area or boundary (corner inside the other, or edges crossing). */
export function ringsOverlap(a: LngLat[], b: LngLat[]): boolean {
  const pa = openRing(a), pb = openRing(b);
  if (!pa.length || !pb.length) return false;
  const [ax0, ay0, ax1, ay1] = bbox(pa), [bx0, by0, bx1, by1] = bbox(pb);
  if (ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0) return false;
  if (pa.some((p) => pointInRing(p, pb)) || pb.some((p) => pointInRing(p, pa))) return true;
  for (let i = 0; i < pa.length; i++)
    for (let j = 0; j < pb.length; j++)
      if (segmentsIntersect(pa[i], pa[(i + 1) % pa.length], pb[j], pb[(j + 1) % pb.length])) return true;
  return false;
}

export function bbox(ring: LngLat[]): [number, number, number, number] {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Pakistan and its borders: the same box the database checks (migration 0057). */
export function inPakistanBox([lng, lat]: LngLat): boolean {
  return lng >= 60 && lng <= 78 && lat >= 23 && lat <= 38;
}

export const MAX_CORNERS = 500;

/** Why a ring cannot be a land-request area, or null when it can. */
export function ringProblem(ring: LngLat[]): string | null {
  const pts = openRing(ring);
  if (pts.length < 3) return 'A land area needs at least 3 corners.';
  if (pts.length > MAX_CORNERS) return `A land area can have at most ${MAX_CORNERS} corners.`;
  if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return 'Every corner needs a latitude and a longitude.';
  if (pts.some((p) => !inPakistanBox(p))) return 'Every corner must be inside Pakistan (latitude 23–38, longitude 60–78).';
  if (ringSelfIntersects(pts)) return 'The boundary crosses itself. Move or remove a corner so the edges do not cross.';
  if (polygonAreaSqm(pts) < 1) return 'The area is too small to be a land parcel.';
  return null;
}

/**
 * Corners typed or pasted from a field GPS, one per line: "lat, lng",
 * "lat lng" or "lat<TAB>lng". Lines that are not two numbers (headers, a
 * corner number in front) are skipped. If every pair reads as
 * [longitude, latitude] instead (KML order), it is swapped.
 */
export function parseCoordinateText(text: string): { ring: LngLat[]; skipped: number } {
  const pairs: [number, number][] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    // "1  28.031  69.3285" — a leading corner number is dropped.
    const two = nums.length === 3 && Number.isInteger(nums[0]) && nums[0] < 1000 ? nums.slice(1) : nums;
    if (two.length !== 2) { skipped++; continue; }
    pairs.push([two[0], two[1]]);
  }
  const latFirst = pairs.every(([a, b]) => a >= 23 && a <= 38 && b >= 60 && b <= 78);
  const lngFirst = !latFirst && pairs.every(([a, b]) => a >= 60 && a <= 78 && b >= 23 && b <= 38);
  const ring: LngLat[] = pairs.map(([a, b]) => (lngFirst ? [a, b] : [b, a]));
  return { ring: openRing(ring), skipped };
}

/** The outer boundary of the first polygon in a KML document (KML order is lng,lat[,alt]). */
export function parseKmlPolygon(kml: string): LngLat[] | null {
  const poly = kml.match(/<Polygon[\s\S]*?<\/Polygon>/i)?.[0];
  if (!poly) return null;
  const outer = poly.match(/<outerBoundaryIs[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i)?.[1]
    ?? poly.match(/<coordinates>([\s\S]*?)<\/coordinates>/i)?.[1];
  if (!outer) return null;
  const ring: LngLat[] = [];
  for (const tok of outer.trim().split(/\s+/)) {
    const [x, y] = tok.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) ring.push([x, y]);
  }
  return ring.length ? openRing(ring) : null;
}

/** Rounded to 7 decimals (about 1 cm), which is what is stored. */
export function roundRing(ring: LngLat[]): LngLat[] {
  const r = (v: number) => Math.round(v * 1e7) / 1e7;
  return openRing(ring).map(([x, y]) => [r(x), r(y)]);
}
