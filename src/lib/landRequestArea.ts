// Server side of land-request polygons (migration 0057): reads a polygon from
// a request body, measures it, stores a version, and works out the parcels it
// covers and the warnings a reviewer should see. Every figure is recomputed
// here; nothing the browser measured is stored.

import type { PoolClient } from 'pg';
import { HttpError } from '@/lib/iam/http';
import {
  type LngLat, SQM_PER_ACRE, centroid, closeRing, pointInRing, polygonAreaSqm, ringProblem, ringsOverlap, roundRing, bbox, openRing,
} from '@/lib/geo';

export const AREA_SOURCES = ['draw', 'coordinates', 'kml'] as const;
export type AreaSource = (typeof AREA_SOURCES)[number];

/** Stages in which nothing more happens to a request. */
export const CLOSED_STAGES = ['Rejected', 'Withdrawn', 'Handed over'];
/** Stages a request is still being prepared in (by its requester). */
export const EDITABLE_STAGES = ['Draft', 'Returned'];

export interface MeasuredArea {
  ring: LngLat[];          // open ring, rounded
  geometry: { type: 'Polygon'; coordinates: LngLat[][] };
  areaSqm: number;
  areaAcres: number;
  centroid: LngLat;
  source: AreaSource;
}

/**
 * The polygon in a request body, if any: `geometry` (a GeoJSON Polygon) or
 * `corners` ([[lng, lat], ...]). Undefined when neither is sent; a 400 when
 * one is sent and is not a usable land area.
 */
export function readArea(body: Record<string, any>): MeasuredArea | undefined {
  let raw: unknown;
  if (body.geometry !== undefined && body.geometry !== null) {
    const g = body.geometry;
    if (typeof g !== 'object' || g.type !== 'Polygon' || !Array.isArray(g.coordinates) || g.coordinates.length !== 1)
      throw new HttpError(400, 'The land area must be one polygon with one outer boundary.', 'validation');
    raw = g.coordinates[0];
  } else if (body.corners !== undefined && body.corners !== null) {
    raw = body.corners;
  } else return undefined;

  if (!Array.isArray(raw) || raw.length > 501)
    throw new HttpError(400, 'The corners must be a list of [longitude, latitude] pairs (at most 500).', 'validation');
  const ring: LngLat[] = raw.map((p: any) => {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number')
      throw new HttpError(400, 'Every corner must be a [longitude, latitude] pair of numbers.', 'validation');
    return [p[0], p[1]];
  });
  const rounded = roundRing(ring);
  const problem = ringProblem(rounded);
  if (problem) throw new HttpError(400, problem, 'validation');

  const source: AreaSource = AREA_SOURCES.includes(body.area_source) ? body.area_source : 'draw';
  const areaSqm = polygonAreaSqm(rounded);
  return {
    ring: rounded,
    geometry: { type: 'Polygon', coordinates: [closeRing(rounded)] },
    areaSqm,
    areaAcres: areaSqm / SQM_PER_ACRE,
    centroid: centroid(rounded),
    source,
  };
}

/** Store the next version of a request's polygon. The database checks the shape, the requester and the stage again. */
export async function saveAreaVersion(client: PoolClient, requestId: string, a: MeasuredArea, userId: string, note?: string | null) {
  const r = await client.query(
    `INSERT INTO lms.land_request_area (land_request_id, province_code, version, geometry, source, area_sqm, area_acres,
                                        centroid_lat, centroid_lng, note, drawn_by)
     SELECT $1, lr.province_code,
            coalesce((SELECT max(version) FROM lms.land_request_area WHERE land_request_id = $1), 0) + 1,
            $2::jsonb, $3, round($4::numeric, 4), round($5::numeric, 4), round($6::numeric, 6), round($7::numeric, 6), $8, $9
       FROM lms.land_request lr WHERE lr.id = $1
     RETURNING id, version, area_acres, area_sqm`,
    [requestId, JSON.stringify(a.geometry), a.source, a.areaSqm, a.areaAcres, a.centroid[1], a.centroid[0], note?.trim() || null, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'Land request not found.', 'not_found');
  return r.rows[0];
}

export function ringOf(geometry: any): LngLat[] {
  const c = geometry?.coordinates?.[0];
  return Array.isArray(c) ? openRing(c.map((p: any) => [Number(p[0]), Number(p[1])] as LngLat)) : [];
}

/** Parcels whose recorded point lies inside the ring (a khasra is a point until boundaries are stored). */
export async function parcelsInside(client: PoolClient, province: string, ring: LngLat[]) {
  if (ring.length < 3) return [];
  const [x0, y0, x1, y1] = bbox(ring);
  const r = await client.query(
    `SELECT s.id, s.code, s.survey_no, s.status_code, s.land_class, s.total_area, s.lat, s.lng, so.location_path
       FROM lms.survey s
       LEFT JOIN api.v_survey_ownership so ON so.survey_id = s.id
      WHERE s.province_code = $1 AND s.lat BETWEEN $2 AND $3 AND s.lng BETWEEN $4 AND $5
      ORDER BY s.code LIMIT 2000`,
    [province, y0, y1, x0, x1]);
  return r.rows
    .filter((s) => pointInRing([Number(s.lng), Number(s.lat)], ring))
    .map((s) => ({ id: s.id, code: s.code, survey_no: s.survey_no, status: s.status_code, land_class: s.land_class,
                   total_area_acres: Number(s.total_area), location: s.location_path, lat: Number(s.lat), lng: Number(s.lng) }));
}

/** Open requests (in the caller's provinces) whose latest polygon overlaps this ring. */
export async function overlappingRequests(client: PoolClient, province: string, ring: LngLat[], exceptId: string | null, userId: string) {
  if (ring.length < 3) return [];
  const r = await client.query(
    `SELECT lr.id, lr.code, lr.stage_code, lr.purpose, a.geometry
       FROM lms.land_request lr
       JOIN LATERAL (SELECT geometry FROM lms.land_request_area x WHERE x.land_request_id = lr.id ORDER BY version DESC LIMIT 1) a ON true
      WHERE lr.province_code = $1 AND lr.stage_code <> ALL ($2::text[])
        AND (lr.stage_code <> 'Draft' OR lr.created_by = $4)
        AND ($3::uuid IS NULL OR lr.id <> $3::uuid)`,
    [province, ['Rejected', 'Withdrawn'], exceptId, userId]);
  return r.rows.filter((o) => ringsOverlap(ring, ringOf(o.geometry)))
    .map((o) => ({ id: o.id, code: o.code, stage: o.stage_code, purpose: o.purpose }));
}

/** Plain-language warnings for the requester and the reviewers. */
export function warningsFor(parcels: Awaited<ReturnType<typeof parcelsInside>>, overlaps: Awaited<ReturnType<typeof overlappingRequests>>,
                            o: { polygonAcres: number | null; requestedAcres: number | null; project?: { lat: number | null; lng: number | null; code: string } | null; centroid?: LngLat | null }) {
  const w: { level: 'danger' | 'warning' | 'info'; text: string }[] = [];
  const by = (s: string) => parcels.filter((p) => p.status === s).map((p) => p.code);
  const list = (xs: string[]) => xs.slice(0, 6).join(', ') + (xs.length > 6 ? ` and ${xs.length - 6} more` : '');
  if (by('Disputed').length) w.push({ level: 'danger', text: `Disputed parcel(s) inside: ${list(by('Disputed'))}.` });
  if (by('Acquired').length) w.push({ level: 'warning', text: `Already acquired by the company: ${list(by('Acquired'))}.` });
  if (by('Leased').length) w.push({ level: 'warning', text: `Already leased by the company: ${list(by('Leased'))}.` });
  if (by('Under Acquisition').length) w.push({ level: 'warning', text: `Already under acquisition: ${list(by('Under Acquisition'))}.` });
  const gov = parcels.filter((p) => p.land_class === 'Government').map((p) => p.code);
  if (gov.length) w.push({ level: 'info', text: `Government land inside (${list(gov)}): in Sindh this goes through DBPFC.` });
  if (o.polygonAcres && o.polygonAcres > 1000) w.push({ level: 'warning', text: `A very large area: ${Math.round(o.polygonAcres).toLocaleString()} acres.` });
  if (overlaps.length) w.push({ level: 'warning', text: `Overlaps other open land request(s): ${overlaps.map((x) => `${x.code} (${x.stage})`).join(', ')}.` });
  if (o.polygonAcres !== null && !parcels.length)
    w.push({ level: 'info', text: 'No recorded parcel lies inside this area. The land team will identify the khasras on the ground.' });
  if (o.polygonAcres && o.requestedAcres && Math.abs(o.polygonAcres - o.requestedAcres) / o.polygonAcres > 0.05)
    w.push({ level: 'info', text: `The required area (${o.requestedAcres.toFixed(2)} ac) differs from the drawn area (${o.polygonAcres.toFixed(2)} ac).` });
  if (o.project?.lat != null && o.project?.lng != null && o.centroid) {
    const km = distanceKm([Number(o.project.lng), Number(o.project.lat)], o.centroid);
    if (km > 25) w.push({ level: 'warning', text: `The area is ${km.toFixed(0)} km from project ${o.project.code}'s recorded location. Check the project or the drawing.` });
  }
  return w;
}

function distanceKm(a: LngLat, b: LngLat) {
  const rad = Math.PI / 180, R = 6371;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
