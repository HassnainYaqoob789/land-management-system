import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKmlText, calculatePolygonAreaSqm, generateMergedKmlXml } from '../../src/lib/kml.ts';

describe('GIS KML/KMZ Parsing, Geometry Extraction & Merge Suite', () => {
  const sampleKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Mari Concession Well-01 Cadastre</name>
    <Placemark>
      <name>Well-01 Pad Boundary</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              68.5000,27.5000,0 68.5050,27.5000,0 68.5050,27.5050,0 68.5000,27.5050,0 68.5000,27.5000,0
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
    <Placemark>
      <name>Access Road Right of Way</name>
      <LineString>
        <coordinates>
          68.5000,27.5000,0 68.5200,27.5100,0
        </coordinates>
      </LineString>
    </Placemark>
    <Placemark>
      <name>Wellhead Center Point</name>
      <Point>
        <coordinates>68.5025,27.5025,0</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>`;

  it('should parse KML text and extract Polygon, LineString, and Point features', () => {
    const result = parseKmlText(sampleKml, 'well_01_boundary.kml');
    assert.equal(result.layerName, 'Mari Concession Well-01 Cadastre');
    assert.equal(result.features.length, 3);

    const poly = result.features.find((f) => f.geometryType === 'Polygon');
    assert.ok(poly);
    assert.equal(poly.name, 'Well-01 Pad Boundary');
    assert.ok(poly.areaSqm > 0);
    assert.ok(poly.areaAcres > 0);
    assert.equal(poly.isValid, true);

    const line = result.features.find((f) => f.geometryType === 'LineString');
    assert.ok(line);
    assert.equal(line.isValid, true);

    const pt = result.features.find((f) => f.geometryType === 'Point');
    assert.ok(pt);
    assert.equal(pt.isValid, true);
  });

  it('should calculate planar polygon area in square meters and acres accurately', () => {
    // 0.005 deg lat/lng square at ~27.5 deg N lat
    const coords = [
      [68.5000, 27.5000],
      [68.5050, 27.5000],
      [68.5050, 27.5050],
      [68.5000, 27.5050],
      [68.5000, 27.5000],
    ];
    const areaSqm = calculatePolygonAreaSqm(coords);
    assert.ok(areaSqm > 200000 && areaSqm < 350000, `Area ${areaSqm} should match approximate 500m x 550m box`);
    const acres = areaSqm / 4046.8564224;
    assert.ok(acres > 50 && acres < 85);
  });

  // UOM-10: the old formula understated parcels in Pakistan by 12–15%.
  // Squares are laid out with the WGS84 radii of curvature at their latitude.
  const square = (lng, lat, sideM) => {
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), r = Math.PI / 180;
    const s2 = Math.sin(lat * r) ** 2;
    const m = (a * (1 - e2)) / Math.pow(1 - e2 * s2, 1.5), n = a / Math.sqrt(1 - e2 * s2);
    const dLat = sideM / m / r, dLng = sideM / (n * Math.cos(lat * r)) / r;
    return [[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]];
  };
  // Independent check: spherical excess on the authalic sphere (Chamberlain & Duquette).
  const sphericalArea = (ring) => {
    const R = 6371007.181, r = Math.PI / 180; let s = 0;
    for (let i = 0; i < ring.length - 1; i++) s += (ring[i + 1][0] - ring[i][0]) * r * (2 + Math.sin(ring[i][1] * r) + Math.sin(ring[i + 1][1] * r));
    return Math.abs((s * R * R) / 2);
  };

  it('measures a 100 m square at 27°N 68°E as 10,000 m² (within 0.1%)', () => {
    const area = calculatePolygonAreaSqm(square(68, 27, 100));
    assert.ok(Math.abs(area - 10000) / 10000 < 0.001, `got ${area}`);
  });

  it('measures a 1 km square at 30°N 71°E as 1,000,000 m² (within 0.1%)', () => {
    const area = calculatePolygonAreaSqm(square(71, 30, 1000));
    assert.ok(Math.abs(area - 1e6) / 1e6 < 0.001, `got ${area}`);
  });

  it('agrees with an independent spherical computation within 0.5%', () => {
    const ring = [[68.5, 27.5], [68.505, 27.5], [68.505, 27.505], [68.5, 27.505], [68.5, 27.5]];
    const a = calculatePolygonAreaSqm(ring), b = sphericalArea(ring);
    assert.ok(Math.abs(a - b) / b < 0.005, `${a} vs ${b}`);
  });

  it('does not depend on ring orientation or on the ring being closed', () => {
    const ring = square(67.9, 25.4, 250);
    const ccw = calculatePolygonAreaSqm(ring);
    assert.ok(Math.abs(calculatePolygonAreaSqm([...ring].reverse()) - ccw) < 1e-6);
    assert.ok(Math.abs(calculatePolygonAreaSqm(ring.slice(0, -1)) - ccw) < 1e-6);
  });

  it('stores the polygon area in acres from the exact factor', () => {
    const [w, s] = [68.1, 26.2];
    const ring = square(w, s, 200);
    const kml = `<kml><Document><Placemark><name>P</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring.map((p) => p.join(',')).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
    const f = parseKmlText(kml).features[0];
    assert.ok(Math.abs(f.areaSqm - 40000) / 40000 < 0.001, `got ${f.areaSqm}`);
    // areaSqm is stored to the whole m² (±0.5 m² = ±0.00012 acre), acres to 4 dp from the exact area.
    assert.ok(Math.abs(f.areaAcres - f.areaSqm / 4046.8564224) <= 0.0002, `${f.areaAcres} acres vs ${f.areaSqm} m²`);
  });

  it('should block external XML entity expansion (XXE Attack Defense)', () => {
    const maliciousKml = `<?xml version="1.0"?>
    <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
    <kml><Document><Placemark><name>&xxe;</name></Placemark></Document></kml>`;

    assert.throws(
      () => {
        parseKmlText(maliciousKml, 'evil.kml');
      },
      /Security Violation: External XML entities are prohibited/
    );
  });

  it('should generate valid merged KML XML document preserving feature provenance', () => {
    const features = [
      {
        feature_name: 'Parcel 101',
        geometry_type: 'Point',
        coordinates: [68.501, 27.501],
        area_acres: 5.2,
        source_file: 'layer_a.kml',
      },
      {
        feature_name: 'Parcel 102',
        geometry_type: 'Point',
        coordinates: [68.502, 27.502],
        area_acres: 3.8,
        source_file: 'layer_b.kml',
      },
    ];

    const xml = generateMergedKmlXml('Daharki Well-01', features);
    assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('Daharki Well-01 - Consolidated Cadastral GIS Merge'));
    assert.ok(xml.includes('<name>Parcel 101</name>'));
    assert.ok(xml.includes('<name>Parcel 102</name>'));
    assert.ok(xml.includes('Developed by Alisons Technology'));
  });
  // The two API checks that were here (anonymous GETs) run signed in, in
  // tests/regression/business_rules.test.ts ('KML features and merge history').
});
