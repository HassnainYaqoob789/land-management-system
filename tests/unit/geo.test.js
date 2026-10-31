import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  polygonAreaSqm, SQM_PER_ACRE, pointInRing, ringSelfIntersects, ringsOverlap, ringProblem,
  parseCoordinateText, parseKmlPolygon, closeRing, centroid,
} from '../../src/lib/geo.ts';

// Land-request polygons (src/lib/geo.ts, migration 0057).
const sq = [[69.3285, 28.027], [69.333, 28.027], [69.333, 28.031], [69.3285, 28.031]];

describe('geo: area', () => {
  it('measures a ~440 m x 445 m square near Daharki at about 48 acres', () => {
    const ac = polygonAreaSqm(sq) / SQM_PER_ACRE;
    assert.ok(ac > 47 && ac < 50, `got ${ac}`);
  });
  it('gives the same area for an open or closed ring', () => {
    assert.equal(polygonAreaSqm(sq), polygonAreaSqm(closeRing(sq)));
  });
  it('puts the centre of a square at its middle', () => {
    const [x, y] = centroid(sq);
    assert.ok(Math.abs(x - 69.33075) < 1e-9 && Math.abs(y - 28.029) < 1e-9);
  });
});

describe('geo: shape checks', () => {
  it('finds a point inside and outside', () => {
    assert.equal(pointInRing([69.33, 28.029], sq), true);
    assert.equal(pointInRing([69.34, 28.029], sq), false);
  });
  it('detects a bow-tie and accepts a plain square', () => {
    assert.equal(ringSelfIntersects([[0, 0], [1, 1], [1, 0], [0, 1]]), true);
    assert.equal(ringSelfIntersects(sq), false);
  });
  it('detects overlap, and none for separate squares', () => {
    const moved = sq.map(([x, y]) => [x + 0.002, y]);
    const far = sq.map(([x, y]) => [x + 0.1, y]);
    assert.equal(ringsOverlap(sq, moved), true);
    assert.equal(ringsOverlap(sq, far), false);
  });
  it('refuses fewer than 3 corners and corners outside Pakistan', () => {
    assert.match(ringProblem(sq.slice(0, 2)), /at least 3/);
    assert.match(ringProblem([[10, 50], [10.1, 50], [10.1, 50.1]]), /inside Pakistan/);
    assert.equal(ringProblem(sq), null);
  });
});

describe('geo: entering corners', () => {
  it('reads pasted "lat, lng" lines, skipping a header and a corner number', () => {
    const { ring, skipped } = parseCoordinateText('Corner Lat Long\n1 28.03100, 69.32850\n2 28.03100 69.33300\n28.027\t69.333\n');
    assert.deepEqual(ring, [[69.3285, 28.031], [69.333, 28.031], [69.333, 28.027]]);
    assert.equal(skipped, 1);
  });
  it('detects longitude-first (KML order) text', () => {
    assert.deepEqual(parseCoordinateText('69.3285,28.031\n69.333,28.031\n69.333,28.027').ring[0], [69.3285, 28.031]);
  });
  it('reads the outer boundary of a KML polygon', () => {
    const kml = '<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>69.3285,28.027,0 69.333,28.027,0 69.333,28.031,0 69.3285,28.027,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>';
    assert.deepEqual(parseKmlPolygon(kml), [[69.3285, 28.027], [69.333, 28.027], [69.333, 28.031]]);
    assert.equal(parseKmlPolygon('<kml><Point><coordinates>69,28</coordinates></Point></kml>'), null);
  });
});
