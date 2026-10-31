import AdmZip from 'adm-zip';

/** A file the user uploaded was refused; the message is written for them. */
export class KmlError extends Error {
  name = 'KmlError';
}

export interface SpatialFeatureResult {
  name: string;
  geometryType: 'Point' | 'LineString' | 'Polygon' | 'MultiPolygon';
  coordinates: any;
  areaSqm: number;
  areaAcres: number;
  metadata: Record<string, any>;
  isValid: boolean;
  validationError?: string;
}

export interface KmlParseResult {
  filename: string;
  layerName: string;
  features: SpatialFeatureResult[];
  errors: string[];
}

// WGS84 ellipsoid (the datum of KML coordinates).
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** Square metres per acre (exact SI definition; the same factor as lms.unit_conversion). */
export const SQM_PER_ACRE = 4046.8564224;

/**
 * Area of a polygon ring ([lng, lat] degrees) in square metres.
 *
 * Every vertex is projected once onto the plane tangent to the WGS84
 * ellipsoid at the ring's centroid (metres per radian from the meridional and
 * prime-vertical radii of curvature there), then the shoelace formula is
 * applied. The earlier version scaled each edge by its own cos(latitude) while
 * using absolute coordinates, which mixed projections and understated parcels
 * in Pakistan by 12–15% (UOM-10). Accurate to well under 0.1% for parcels and
 * blocks up to tens of kilometres across.
 */
export function calculatePolygonAreaSqm(coords: [number, number][]): number {
  if (!coords || coords.length < 3) return 0;
  const ring = coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1]
    ? coords.slice(0, -1) : coords;
  if (ring.length < 3) return 0;
  const rad = Math.PI / 180;
  const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * rad;
  const lng0 = (ring.reduce((s, p) => s + p[0], 0) / ring.length) * rad;
  const s2 = Math.sin(lat0) ** 2;
  const m = (WGS84_A * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * s2, 1.5);   // meridional radius
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s2);                          // prime-vertical radius
  const xy = ring.map(([lng, lat]) => [(lng * rad - lng0) * n * Math.cos(lat0), (lat * rad - lat0) * m]);
  let twice = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice / 2);
}

/**
 * Parse KML coordinate strings: "lng,lat,alt lng,lat,alt"
 */
function parseCoordinateList(coordStr: string): [number, number][] {
  const points: [number, number][] = [];
  const tokens = coordStr.trim().split(/\s+/);
  for (const token of tokens) {
    if (!token.trim()) continue;
    const parts = token.split(',');
    if (parts.length >= 2) {
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isNaN(lng) && !isNaN(lat)) {
        points.push([lng, lat]);
      }
    }
  }
  return points;
}

/**
 * Parses raw KML text securely extracting Point, LineString, Polygon
 */
export function parseKmlText(kmlText: string, defaultName = 'KML Layer'): KmlParseResult {
  const features: SpatialFeatureResult[] = [];
  const errors: string[] = [];

  // Protect against XML entity expansion / XXE
  if (/<!ENTITY/i.test(kmlText)) {
    throw new KmlError('Security Violation: External XML entities are prohibited in KML uploads');
  }

  // Extract Document/Folder Name if available
  const docNameMatch = kmlText.match(/<Document[^>]*>[\s\S]*?<name>([^<]+)<\/name>/i) ||
                       kmlText.match(/<Folder[^>]*>[\s\S]*?<name>([^<]+)<\/name>/i);
  const layerName = docNameMatch ? docNameMatch[1].trim() : defaultName;

  // Split by Placemark
  const placemarkMatches = kmlText.matchAll(/<Placemark[\s\S]*?<\/Placemark>/gi);

  for (const match of placemarkMatches) {
    const block = match[0];
    const nameMatch = block.match(/<name>([^<]+)<\/name>/i);
    const featureName = nameMatch ? nameMatch[1].trim() : 'Unnamed Feature';

    let geometryType: 'Point' | 'LineString' | 'Polygon' | 'MultiPolygon' = 'Point';
    let coordinates: any = null;
    let areaSqm = 0;
    let areaAcres = 0;
    let isValid = true;
    let validationError: string | undefined;

    try {
      // Check Polygon
      if (/<Polygon/i.test(block)) {
        geometryType = 'Polygon';
        const coordsMatch = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
        if (coordsMatch) {
          const linearRing = parseCoordinateList(coordsMatch[1]);
          if (linearRing.length >= 3) {
            // Close loop if not closed
            if (
              linearRing[0][0] !== linearRing[linearRing.length - 1][0] ||
              linearRing[0][1] !== linearRing[linearRing.length - 1][1]
            ) {
              linearRing.push([linearRing[0][0], linearRing[0][1]]);
            }
            coordinates = [linearRing];
            areaSqm = calculatePolygonAreaSqm(linearRing);
            areaAcres = parseFloat((areaSqm / SQM_PER_ACRE).toFixed(4));
          } else {
            isValid = false;
            validationError = 'Polygon requires at least 3 distinct coordinates';
          }
        }
      } else if (/<LineString/i.test(block)) {
        geometryType = 'LineString';
        const coordsMatch = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
        if (coordsMatch) {
          coordinates = parseCoordinateList(coordsMatch[1]);
          if (coordinates.length < 2) {
            isValid = false;
            validationError = 'LineString requires at least 2 coordinate points';
          }
        }
      } else if (/<Point/i.test(block)) {
        geometryType = 'Point';
        const coordsMatch = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
        if (coordsMatch) {
          const pt = parseCoordinateList(coordsMatch[1]);
          if (pt.length >= 1) {
            coordinates = pt[0];
          } else {
            isValid = false;
            validationError = 'Invalid Point coordinates';
          }
        }
      }

      // Check Coordinate Bounding Box for Pakistan Concessions (lat 23-38, lng 60-78)
      if (coordinates) {
        const checkCoords = geometryType === 'Point' 
          ? [coordinates] 
          : geometryType === 'LineString' 
            ? coordinates 
            : coordinates[0];
        
        for (const [lng, lat] of checkCoords) {
          if (lat < 23.0 || lat > 38.0 || lng < 60.0 || lng > 78.0) {
            isValid = false;
            validationError = `Coordinates [${lng}, ${lat}] fall outside Pakistan concession boundaries`;
            break;
          }
        }
      } else {
        isValid = false;
        validationError = 'No supported geometry found in Placemark';
      }

      features.push({
        name: featureName,
        geometryType,
        coordinates,
        areaSqm: Math.round(areaSqm),
        areaAcres,
        metadata: { source_kml: defaultName },
        isValid,
        validationError,
      });
    } catch (e: any) {
      errors.push(`Error parsing placemark "${featureName}": ${e.message}`);
    }
  }

  return {
    filename: defaultName,
    layerName,
    features,
    errors,
  };
}

/**
 * Parses KMZ (zipped archive) or KML buffer safely
 */
export function parseKmlOrKmzBuffer(buffer: Buffer, originalFilename: string): KmlParseResult {
  const isKmz = originalFilename.toLowerCase().endsWith('.kmz');

  if (isKmz) {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new KmlError('Invalid KMZ: the file is not a readable archive');
    }
    const zipEntries = zip.getEntries();

    // Check directory traversal guard
    for (const entry of zipEntries) {
      if (entry.entryName.includes('..') || entry.entryName.startsWith('/')) {
        throw new KmlError('Security Violation: Archive traversal detected in KMZ');
      }
    }

    // Find main kml file (usually doc.kml or any .kml)
    const kmlEntry = zipEntries.find((e) => e.entryName.toLowerCase().endsWith('.kml'));
    if (!kmlEntry) {
      throw new KmlError('Invalid KMZ: No .kml file found inside archive');
    }

    const kmlText = kmlEntry.getData().toString('utf8');
    return parseKmlText(kmlText, originalFilename);
  }

  // Regular KML text
  const kmlText = buffer.toString('utf8');
  return parseKmlText(kmlText, originalFilename);
}

/**
 * Builds valid KML XML representation from an array of spatial features
 */
export function generateMergedKmlXml(projectName: string, features: any[]): string {
  const placemarksXml = features
    .map((f) => {
      let geomXml = '';
      if (f.geometry_type === 'Polygon' || f.geometryType === 'Polygon') {
        const coords = f.coordinates?.[0] || [];
        const coordStr = coords.map((c: any) => `${c[0]},${c[1]},0`).join(' ');
        geomXml = `
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>${coordStr}</coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>`;
      } else if (f.geometry_type === 'LineString' || f.geometryType === 'LineString') {
        const coords = f.coordinates || [];
        const coordStr = coords.map((c: any) => `${c[0]},${c[1]},0`).join(' ');
        geomXml = `
        <LineString>
          <coordinates>${coordStr}</coordinates>
        </LineString>`;
      } else if (f.geometry_type === 'Point' || f.geometryType === 'Point') {
        const coords = f.coordinates || [0, 0];
        geomXml = `
        <Point>
          <coordinates>${coords[0]},${coords[1]},0</coordinates>
        </Point>`;
      }

      return `
      <Placemark>
        <name>${escapeXml(f.feature_name || f.name || 'Merged Parcel')}</name>
        <description>Area: ${f.area_acres || f.areaAcres || 0} Acres · Source: ${escapeXml(f.source_file || 'Merged Dataset')}</description>
        ${geomXml}
      </Placemark>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(projectName)} - Consolidated Cadastral GIS Merge</name>
    <description>Consolidated GIS layer generated by Mari Energies Limited LMS · Developed by Alisons Technology</description>
    ${placemarksXml}
  </Document>
</kml>`;
}

function escapeXml(unsafe: string): string {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
