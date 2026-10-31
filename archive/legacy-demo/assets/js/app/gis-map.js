/* GIS land map — MapLibre GL (WebGL) in place of Leaflet.

   Everything the Leaflet map did is kept: parcels by status, wells and
   facilities, ROW corridors, encroachments with risk zones, uploaded
   KML / KMZ / GeoJSON, search, distance and area measurement, drawing a
   parcel boundary or a ROW route, editing boundary corners, reporting an
   encroachment by clicking, and deep links (?lat=&lng=&id=).

   Added with the move to GL:
   - basemaps: streets, satellite imagery, topographic, or none (offline);
   - 3D terrain with hillshading;
   - "colour parcels by" land status, land class, lease expiry or
     compensation paid, with a legend that counts each band;
   - an encroachment hotspot heatmap;
   - a live summary of what is in view (parcels, acreage, wells, ROW length,
     open encroachments) and a table of the parcels in view — which is also
     the text alternative to the map for keyboard and screen-reader users;
   - survey labels at close zoom, hover highlighting, and the camera kept
     when the screen redraws after a save.

   Coordinates: the app stores [lat, lng]; MapLibre wants [lng, lat].
   This file is hand-written; ui/gis.js keeps the data functions it uses
   (surveyPopup, saveBoundary, saveRoute, polyAcres, the file parsers). */
'use strict';

const GLS = {
  basemap: 'streets', theme: 'status', terrain: false,
  layers: { parcels: true, fac: true, row: true, enc: true, heat: false, up: true },
  tool: null, pts: [], edit: null, lastView: null, popup: null, labels: [], data: null,
};

/* ---- small geometry helpers ([lat, lng] in, metres / acres out) -------- */
const toLngLat = p => [p[1], p[0]];
function haversine(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pathLen(p) { let d = 0; for (let i = 1; i < p.length; i++) d += haversine(p[i - 1], p[i]); return d; }
function nearestSurvey(ll) {
  let best = null, bd = 1e12;
  ctxRows('surveys').forEach(s => { if (!s.lat) return; const d = haversine(ll, [s.lat, s.lng]); if (d < bd) { bd = d; best = s; } });
  return bd < 3000 ? best : null;
}
/* a circle of the parcel's recorded area, for surveys with no drawn boundary */
function circleRing(lat, lng, metres, n = 48) {
  const out = [], dLat = metres / 111320, dLng = metres / (111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= n; i++) { const t = i / n * 2 * Math.PI; out.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]); }
  return out;
}
const closeRing = ring => (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) ? ring.concat([ring[0]]) : ring;
const centroid = pts => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];

/* ---- colouring parcels ------------------------------------------------- */
const LEASE_BANDS = [
  ['No lease', '#8a9bb0'], ['Expired', '#d93a3a'], ['≤ 90 days', '#e0731a'],
  ['≤ 1 year', '#e0b21a'], ['> 1 year', '#16a061'],
];
const PAID_BANDS = [
  ['Nothing paid', '#8a9bb0'], ['Under Rs 1 M', '#9cc7f5'], ['Rs 1 – 5 M', '#3d8be0'], ['Over Rs 5 M', '#16467a'],
];
const CLASS_PALETTE = ['#2368b0', '#b45309', '#16a061', '#7a4fc2', '#1597a6', '#d93a3a', '#6b7280'];

function leaseBand(s) {
  const ls = S.leases.filter(l => (l.surveyIds || []).includes(s.id) && l.stage !== 'Cancelled');
  if (!ls.length) return LEASE_BANDS[0];
  const days = Math.max(...ls.map(l => { const i = leaseInfo(l); return i.status === 'Expired' ? -1 : num(i.days); }));
  return days < 0 ? LEASE_BANDS[1] : days <= 90 ? LEASE_BANDS[2] : days <= 365 ? LEASE_BANDS[3] : LEASE_BANDS[4];
}
function paidFor(s) {
  const cs = S.cases.filter(c => (c.leaseLines || []).some(l => l.surveyId === s.id) && c.stage !== 'Cancelled');
  const ls = S.leases.filter(l => (l.surveyIds || []).includes(s.id));
  return sum(S.payments.filter(p => p.stage === 'Released' && (cs.some(c => c.id === p.caseId) || ls.some(l => l.id === p.leaseId))), 'net');
}
function paidBand(s) {
  const v = paidFor(s);
  return v <= 0 ? PAID_BANDS[0] : v < 1e6 ? PAID_BANDS[1] : v <= 5e6 ? PAID_BANDS[2] : PAID_BANDS[3];
}
function classColours() {
  const m = {};
  uniq(ctxRows('surveys').map(s => s.landClass || 'Unclassified')).sort()
    .forEach((c, i) => { m[c] = CLASS_PALETTE[i % CLASS_PALETTE.length]; });
  return m;
}
/* [band label, colour] for a parcel under the current theme */
function parcelBand(s, classes) {
  if (GLS.theme === 'lease') return leaseBand(s);
  if (GLS.theme === 'paid') return paidBand(s);
  if (GLS.theme === 'class') { const c = s.landClass || 'Unclassified'; return [c, classes[c]]; }
  return [s.status || 'Unknown', ST_COL[s.status] || '#888'];
}

/* ---- the data, as GeoJSON ----------------------------------------------- */
function buildData() {
  const fc = f => ({ type: 'FeatureCollection', features: f });
  const linked = new Map();
  S.gis.forEach(Lr => Lr.features.forEach(f => { if (f.surveyId) linked.set(f.surveyId, f); }));
  const classes = classColours();
  const parcels = [], dots = [];
  ctxRows('surveys').forEach(s => {
    const lk = linked.get(s.id);
    const ring = s.geom && s.geom.length > 2 ? s.geom
      : lk ? lk.geoms.find(g => g.type === 'Polygon').pts : null;
    const [band, colour] = parcelBand(s, classes);
    const props = { id: s.id, code: s.code, label: s.code + ' · ' + surveyNoTxt(s), band, colour,
      status: s.status || '', acres: num(s.totalArea), drawn: ring ? 1 : 0 };
    let geom = null, ctr = null;
    if (ring) { geom = { type: 'Polygon', coordinates: [closeRing(ring.map(toLngLat))] }; ctr = centroid(ring); }
    else if (s.lat && s.lng) {
      geom = { type: 'Polygon', coordinates: [circleRing(s.lat, s.lng, Math.sqrt(num(s.totalArea) * 4046.856 / Math.PI) || 30)] };
      ctr = [s.lat, s.lng];
    }
    if (!geom) return;
    parcels.push({ type: 'Feature', id: parcels.length + 1, geometry: geom, properties: props });
    dots.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(ctr) }, properties: Object.assign({ lat: ctr[0], lng: ctr[1] }, props) });
  });

  const fac = ctxRows('projects').filter(p => p.lat && p.lng).map(p => ({ type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: { id: p.id, code: p.code, colour: PT_COL[p.type] || '#111827', type: p.type || '' } }));

  const rows = [];
  ctxRows('rows').forEach(r => {
    const pts = String(r.path || '').split(';').map(x => x.split(',').map(Number)).filter(a => a.length === 2 && !isNaN(a[0]) && !isNaN(a[1]));
    if (pts.length < 2) return;
    rows.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(toLngLat) },
      properties: { id: r.id, code: r.code, stopped: r.stage === 'Stopped' ? 1 : 0, metres: pathLen(pts) } });
  });

  const enc = ctxRows('encroachments').filter(e => e.lat && e.lng).map(e => {
    const colour = e.stage === 'Resolved' ? '#16a061' : (e.risk === 'Critical' || e.risk === 'High') ? '#d93a3a' : '#e09a1a';
    const weight = e.stage === 'Resolved' ? 0.2 : e.risk === 'Critical' ? 1 : e.risk === 'High' ? 0.8 : e.risk === 'Medium' ? 0.5 : 0.3;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
      properties: { id: e.id, code: e.code, colour, weight, open: e.stage === 'Resolved' ? 0 : 1 } };
  });

  const up = [];
  S.gis.forEach(Lr => Lr.features.forEach(f => {
    if (f.surveyId) return;
    f.geoms.forEach(g => {
      const geometry = g.type === 'Point' ? { type: 'Point', coordinates: toLngLat(g.pts[0]) }
        : g.type === 'LineString' ? { type: 'LineString', coordinates: g.pts.map(toLngLat) }
        : { type: 'Polygon', coordinates: [closeRing(g.pts.map(toLngLat))] };
      up.push({ type: 'Feature', geometry, properties: { name: f.name, layer: Lr.name, desc: (f.desc || '').slice(0, 200),
        acres: g.type === 'Polygon' ? polyAcres(g.pts) : 0, kind: g.type } });
    });
  }));
  return { parcels: fc(parcels), dots: fc(dots), fac: fc(fac), rows: fc(rows), enc: fc(enc), up: fc(up), classes };
}

/* ---- the screen ----------------------------------------------------------- */
function scrGIS() {
  const sel = (act, cur, opts, label) => `<label class="gl-field"><span>${label}</span><select class="sel" data-act="${act}">`
    + opts.map(([v, t]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`).join('') + '</select></label>';
  const layer = (k, t) => `<label class="gl-check"><input type="checkbox" data-act="gisLayer" data-a1="${k}" ${GLS.layers[k] ? 'checked' : ''}> ${t} <span class="note" id="glCount-${k}"></span></label>`;
  return `<div class="card"><div class="card-h"><div><h3>📍 GIS land map</h3><p>Land parcels, wells and facilities, ROW corridors, encroachments and your uploaded KML / KMZ / GeoJSON on a GL map. Click any feature for its land record; choose how parcels are coloured; switch on 3D terrain.</p></div></div>
  <div class="maptools">
    <input class="search" id="mapQ" placeholder="Search survey no., landowner, CNIC, project…" aria-label="Search the map" data-enter="mapSearch">
    <button class="btn btn-s btn-sm" data-act="mapSearch">🔍 Find</button>
    ${sel('gisBasemap', GLS.basemap, [['streets', 'Streets'], ['satellite', 'Satellite imagery'], ['topo', 'Topographic'], ['none', 'None (works offline)']], 'Basemap')}
    ${sel('gisTheme', GLS.theme, [['status', 'Land status'], ['class', 'Land class'], ['lease', 'Lease expiry'], ['paid', 'Compensation paid']], 'Colour parcels by')}
    <button class="btn btn-s btn-sm" id="glTerrain" data-act="gisTerrain" aria-pressed="${GLS.terrain}">⛰ 3D terrain</button>
    <button class="btn btn-s btn-sm" data-act="gisFit">⤢ Show all</button>
  </div>
  <div class="maptools tools-strip" role="toolbar" aria-label="Map tools">
    <button class="btn btn-s btn-sm" id="tDist" data-act="mapTool" data-a1="dist" aria-pressed="false">📏 Measure distance</button>
    <button class="btn btn-s btn-sm" id="tArea" data-act="mapTool" data-a1="area" aria-pressed="false">⬠ Measure area</button>
    ${can.create() ? `<button class="btn btn-s btn-sm" id="tDraw" data-act="mapTool" data-a1="draw" aria-pressed="false">✏ Draw parcel boundary</button>
    <button class="btn btn-s btn-sm" id="tRoute" data-act="mapTool" data-a1="route" aria-pressed="false">〰 Draw ROW route</button>
    <button class="btn btn-w btn-sm" id="tEnc" data-act="mapTool" data-a1="enc" aria-pressed="false">⚠ Report encroachment here</button>` : ''}
    <button class="btn btn-s btn-sm" data-act="gisClear">✕ Clear drawing</button>
    <span class="grow u-flex-1"></span>
    ${can.create() ? `<label class="btn btn-g btn-sm">📤 Upload KML / KMZ / GeoJSON<input type="file" class="hidden" accept=".kml,.kmz,.geojson,.json" data-act="gisPick"></label>` : ''}<button class="btn btn-s btn-sm" data-act="sampleKML">⬇ Sample KML</button>
  </div>
  <div id="mapMsg" class="note u-mb-6" role="status" aria-live="polite"></div>
  <div class="gl-wrap">
    <div id="map" role="region" aria-label="Interactive land map. The table of parcels in view below lists the same parcels as text."></div>
    <aside class="gl-side" aria-label="Map layers and summary">
      <h4>Layers</h4>
      ${layer('parcels', 'Land parcels')}${layer('fac', 'Wells &amp; facilities')}${layer('row', 'ROW corridors')}${layer('enc', 'Encroachments')}${layer('heat', 'Encroachment hotspots')}${layer('up', 'Uploaded KML / GeoJSON')}
      <h4>Legend</h4><div id="glLegend" class="gl-legend"></div>
      <h4>In view</h4><div id="glSummary" class="gl-summary"></div>
    </aside>
  </div></div>
  <div class="card"><div class="card-h"><div><h3>Parcels in view</h3><p id="glInViewNote">The parcels currently on the map. Choose one to fly to it.</p></div></div>
  <div class="tw u-mh-300"><table class="t"><thead><tr><th>Survey</th><th>Location</th><th>Status</th><th>Shown as</th><th class="num">Area (ac)</th><th>Owners</th></tr></thead><tbody id="glInView"><tr><td colspan="6" class="empty">Loading the map…</td></tr></tbody></table></div></div>
  <div class="card"><div class="card-h"><div><h3>Uploaded GIS layers</h3><p>Features from KML / KMZ / GeoJSON files. Link a polygon to a survey to make it that parcel's boundary.</p></div></div>
  <div class="tw u-mh-300"><table class="t"><thead><tr><th>Layer / file</th><th>Feature</th><th>Geometry</th><th>Points</th><th>Area</th><th>Linked survey</th><th>Uploaded</th><th>Actions</th></tr></thead><tbody>${S.gis.length ? S.gis.map(L => L.features.map((f, i) => `<tr><td>${esc(L.name)}</td><td>${esc(f.name)}</td><td>${f.geoms.map(g => g.type).join(', ')}</td><td class="num">${sum(f.geoms, g => g.pts.length)}</td><td class="num">${f.geoms.some(g => g.type === 'Polygon') ? fmt(polyAcres(f.geoms.find(g => g.type === 'Polygon').pts), 3) + ' ac' : '-'}</td><td>${f.surveyId ? esc(codeOf('surveys', f.surveyId)) : '-'}</td><td>${fdt(L.at)} · ${esc(L.user)}</td>
    <td><div class="acts">${can.create() && f.geoms.some(g => g.type === 'Polygon') ? `<button data-act="gisLink" data-a1="${L.id}" data-a2="${esc(i)}">🔗 Link survey</button>` : ''}${can.admin() || L.user === ME.username ? `<button class="del" data-act="gisDel" data-a1="${L.id}" aria-label="Remove layer ${esc(L.name)}">🗑</button>` : ''}</div></td></tr>`).join('')).join('') : '<tr><td colspan="8" class="empty">No uploaded layers yet — use “Upload KML / KMZ / GeoJSON” (try the sample KML)</td></tr>'}</tbody></table></div></div>`;
}

/* ---- the map's style: every basemap present, one visible --------------- */
const BASEMAPS = {
  streets: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© OpenStreetMap contributors' },
  satellite: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Imagery © Esri' },
  topo: { tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png'], attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors', maxzoom: 17 },
};
const TERRAIN_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];

function baseStyle() {
  const sources = {}, layers = [{ id: 'bg', type: 'background', paint: { 'background-color': '#e8edf3' } }];
  Object.entries(BASEMAPS).forEach(([k, b]) => {
    sources['base-' + k] = { type: 'raster', tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom || 19 };
    layers.push({ id: 'base-' + k, type: 'raster', source: 'base-' + k, layout: { visibility: GLS.basemap === k ? 'visible' : 'none' } });
  });
  return { version: 8, sources, layers };
}

function addDataLayers(map) {
  const d = GLS.data;
  ['parcels', 'dots', 'fac', 'rows', 'enc', 'up'].forEach(k => map.addSource(k, { type: 'geojson', data: d[k] }));
  map.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({ id: 'enc-heat', type: 'heatmap', source: 'enc', maxzoom: 16,
    paint: { 'heatmap-weight': ['get', 'weight'], 'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 5, 18, 12, 40],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 5, 1, 12, 2.5], 'heatmap-opacity': 0.75 } });
  map.addLayer({ id: 'parcels-fill', type: 'fill', source: 'parcels',
    paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.6, 0.35] } });
  map.addLayer({ id: 'parcels-line', type: 'line', source: 'parcels',
    paint: { 'line-color': ['get', 'colour'], 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 3.5, 2] } });
  map.addLayer({ id: 'parcels-dot', type: 'circle', source: 'dots',
    paint: { 'circle-radius': 5, 'circle-color': ['get', 'colour'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'row-line', type: 'line', source: 'rows',
    paint: { 'line-color': ['case', ['==', ['get', 'stopped'], 1], '#999999', '#7a4fc2'], 'line-width': 5, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'row-stopped', type: 'line', source: 'rows', filter: ['==', ['get', 'stopped'], 1],
    paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'fac-pt', type: 'circle', source: 'fac',
    paint: { 'circle-radius': 7, 'circle-color': ['get', 'colour'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  // an encroachment's risk zone: about 120 m across at every zoom
  map.addLayer({ id: 'enc-zone', type: 'circle', source: 'enc',
    paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, 1, 20, 1024], 'circle-color': ['get', 'colour'],
      'circle-opacity': 0.15, 'circle-stroke-color': ['get', 'colour'], 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'enc-pt', type: 'circle', source: 'enc',
    paint: { 'circle-radius': 6, 'circle-color': ['get', 'colour'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'up-fill', type: 'fill', source: 'up', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'up-line', type: 'line', source: 'up', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#0ea5e9', 'line-width': 2 } });
  map.addLayer({ id: 'up-pt', type: 'circle', source: 'up', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#0ea5e9', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  // what the user is drawing
  map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#e11d48', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#e11d48', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'draft-pt', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#e11d48', 'circle-stroke-width': 2 } });
  applyLayerVisibility(map);
}

const LAYER_GROUPS = {
  parcels: ['parcels-fill', 'parcels-line', 'parcels-dot'], fac: ['fac-pt'], row: ['row-line', 'row-stopped'],
  enc: ['enc-zone', 'enc-pt'], heat: ['enc-heat'], up: ['up-fill', 'up-line', 'up-pt'],
};
function applyLayerVisibility(map) {
  Object.entries(LAYER_GROUPS).forEach(([k, ids]) => ids.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', GLS.layers[k] ? 'visible' : 'none');
  }));
}

/* ---- legend, counts, and "in view" ------------------------------------- */
function renderLegend() {
  const el = $('#glLegend'); if (!el || !GLS.data) return;
  const counts = {};
  GLS.data.parcels.features.forEach(f => { const k = f.properties.band; counts[k] = counts[k] || { n: 0, c: f.properties.colour }; counts[k].n++; });
  const order = GLS.theme === 'lease' ? LEASE_BANDS.map(b => b[0]) : GLS.theme === 'paid' ? PAID_BANDS.map(b => b[0])
    : GLS.theme === 'status' ? Object.keys(ST_COL) : Object.keys(counts).sort();
  const colourOf = k => (counts[k] && counts[k].c) || (GLS.theme === 'status' ? ST_COL[k]
    : (LEASE_BANDS.concat(PAID_BANDS).find(b => b[0] === k) || [])[1] || '#888');
  el.innerHTML = order.map(k => `<div><i data-bg="${esc(colourOf(k))}"></i>${esc(k)} <span class="note">${counts[k] ? counts[k].n : 0}</span></div>`).join('')
    + '<div class="gl-legend-sep"></div><div><i class="lgd-bar u-bg-row"></i>ROW corridor</div><div><i data-bg="#111827"></i>Well / facility</div><div><i class="u-bg-danger"></i>Encroachment (high risk)</div><div><i data-bg="#0ea5e9"></i>Uploaded feature</div>';
  applyDynamic(el);
  const n = { parcels: GLS.data.parcels.features.length, fac: GLS.data.fac.features.length, row: GLS.data.rows.features.length,
    enc: GLS.data.enc.features.length, heat: GLS.data.enc.features.filter(f => f.properties.open).length, up: GLS.data.up.features.length };
  Object.entries(n).forEach(([k, v]) => { const c = $('#glCount-' + k); if (c) c.textContent = '(' + v + ')'; });
}

function updateInView() {
  const map = window._map; if (!map || !GLS.data) return;
  const b = map.getBounds();
  const inside = ([lng, lat]) => b.contains([lng, lat]);
  const dots = GLS.data.dots.features.filter(f => inside(f.geometry.coordinates));
  const acres = dots.reduce((a, f) => a + num(f.properties.acres), 0);
  const fac = GLS.data.fac.features.filter(f => inside(f.geometry.coordinates)).length;
  const rowM = GLS.data.rows.features.filter(f => f.geometry.coordinates.some(inside)).reduce((a, f) => a + f.properties.metres, 0);
  const encOpen = GLS.data.enc.features.filter(f => f.properties.open && inside(f.geometry.coordinates)).length;
  const byBand = {};
  dots.forEach(f => { const k = f.properties.band; byBand[k] = byBand[k] || { n: 0, ac: 0, c: f.properties.colour }; byBand[k].n++; byBand[k].ac += num(f.properties.acres); });
  const sumEl = $('#glSummary');
  if (sumEl) {
    sumEl.innerHTML = `<div class="gl-stats"><div><b>${fmt(dots.length)}</b><small>parcels</small></div><div><b>${fmt(acres, 1)}</b><small>acres</small></div>`
      + `<div><b>${fmt(fac)}</b><small>wells / facilities</small></div><div><b>${fmt(rowM / 1000, 2)}</b><small>km of ROW</small></div>`
      + `<div><b class="${encOpen ? 'is-bad' : ''}">${fmt(encOpen)}</b><small>open encroachments</small></div></div>`
      + Object.entries(byBand).sort((x, y) => y[1].ac - x[1].ac).map(([k, v]) =>
        `<div class="gl-bar"><span>${esc(k)}</span><span class="note">${fmt(v.ac, 1)} ac</span><i data-bg="${esc(v.c)}" class="gl-bar-fill" data-w="${acres ? Math.round(v.ac / acres * 100) : 0}"></i></div>`).join('');
    sumEl.querySelectorAll('[data-w]').forEach(i => i.style.setProperty('--w', i.dataset.w + '%'));
    applyDynamic(sumEl);
  }
  const tb = $('#glInView');
  if (tb) {
    const max = 60, list = dots.slice(0, max);
    tb.innerHTML = list.length ? list.map(f => {
      const s = byId('surveys', f.properties.id); if (!s) return '';
      return `<tr class="is-link"><td><button class="as-link mono" data-act="gisFly" data-a1="${esc(s.id)}">${esc(s.code)}</button> ${esc(surveyNoTxt(s))}</td>`
        + `<td>${esc(unitName(s.unitId))}</td><td>${stageBadge(s.status)}</td><td><i class="gl-swatch" data-bg="${esc(f.properties.colour)}"></i>${esc(f.properties.band)}</td>`
        + `<td class="num">${fmt(s.totalArea, 2)}</td><td>${esc(ownersOfSurvey(s.id).map(o => o.name).join(', ') || '-')}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">No parcels in this part of the map — zoom out or choose “Show all”.</td></tr>';
    applyDynamic(tb);
    const note = $('#glInViewNote');
    if (note) note.textContent = dots.length > max ? `Showing ${max} of ${fmt(dots.length)} parcels in view — zoom in to narrow the list.`
      : 'The parcels currently on the map. Choose one to fly to it.';
  }
  updateLabels();
}

/* survey codes as labels once zoomed in (HTML, so no font server is needed) */
function updateLabels() {
  const map = window._map; if (!map) return;
  GLS.labels.forEach(m => m.remove()); GLS.labels = [];
  if (map.getZoom() < 13 || !GLS.layers.parcels) return;
  const b = map.getBounds();
  GLS.data.dots.features.filter(f => b.contains(f.geometry.coordinates)).slice(0, 150).forEach(f => {
    const el = document.createElement('div');
    el.className = 'gl-label';
    el.textContent = f.properties.code;
    el.setAttribute('aria-hidden', 'true');
    GLS.labels.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 6] }).setLngLat(f.geometry.coordinates).addTo(map));
  });
}

/* ---- popups ---------------------------------------------------------------- */
function openPopup(lngLat, html) {
  const map = window._map; if (!map) return;
  if (GLS.popup) GLS.popup.remove();
  GLS.popup = new maplibregl.Popup({ maxWidth: '330px', focusAfterOpen: true }).setLngLat(lngLat).setHTML(html).addTo(map);
  const el = GLS.popup.getElement();
  applyDynamic(el); if (typeof a11yPass === 'function') a11yPass(el); iconize(el);
}
function surveyPopupAt(id) {
  const f = GLS.data && GLS.data.dots.features.find(x => x.properties.id === id);
  const s = byId('surveys', id);
  if (f && s) openPopup(f.geometry.coordinates, surveyPopup(s));
}
function popupFor(layerId, f) {
  const p = f.properties;
  if (layerId.startsWith('parcels')) { const s = byId('surveys', p.id); return s ? surveyPopup(s) : ''; }
  if (layerId === 'fac-pt') { const pj = byId('projects', p.id); return pj ? `<b>${esc(pj.code)}</b><br>${esc(pj.name)}<br>${esc(pj.type)} · ${esc(pj.block)}<br>Status: ${esc(pj.status)}<br><a href="${pageUrl('projects')}?view=${encodeURIComponent(pj.id)}" data-act="openView" data-a1="projects" data-a2="${esc(pj.id)}">Open project ›</a>` : ''; }
  if (layerId.startsWith('row')) { const r = byId('rows', p.id); if (!r) return ''; const i = rowInfo(r); return `<b>${esc(r.code)}</b> — ${esc(r.name)}<br>${esc(r.rowType)} · ${fmt(r.lengthM)} m × ${fmt(r.widthM)} m = ${fmt(i.area, 2)} ac<br>Mapped length ${fmt(p.metres)} m<br>Next renewal: ${fdt(i.next)}<br><a href="${pageUrl('rows')}?view=${encodeURIComponent(r.id)}" data-act="openView" data-a1="rows" data-a2="${esc(r.id)}">Open ROW ›</a>`; }
  if (layerId.startsWith('enc')) { const e = byId('encroachments', p.id); return e ? `<b>⚠ ${esc(e.code)}</b><br>${esc(e.category)}<br>Risk: <b>${esc(e.risk)}</b> · ${esc(e.stage)}<br>${esc(e.description || '')}<br>📎 ${docsFor(e.id).filter(d => !d.deleted).length} evidence file(s)<br><a href="${pageUrl('encroachments')}?view=${encodeURIComponent(e.id)}" data-act="openView" data-a1="encroachments" data-a2="${esc(e.id)}">Open incident ›</a>` : ''; }
  if (layerId.startsWith('up')) return `<b>${esc(p.name)}</b><br><small>${esc(p.layer)}</small><br>${esc(p.desc)}${p.acres ? '<br>Area ≈ ' + fmt(p.acres, 3) + ' ac (' + ag(p.acres) + ')' : ''}`;
  return '';
}
const CLICKABLE = ['enc-pt', 'fac-pt', 'parcels-dot', 'row-line', 'up-pt', 'up-line', 'up-fill', 'parcels-fill'];

/* ---- drawing and measuring --------------------------------------------- */
function draftSet(features) {
  const map = window._map; if (!map || !map.getSource('draft')) return;
  map.getSource('draft').setData({ type: 'FeatureCollection', features });
}
function drawDraft() {
  const pts = GLS.pts, f = [];
  const asPoly = (GLS.tool === 'area' || GLS.tool === 'draw') && pts.length > 2;
  if (pts.length > 1) f.push({ type: 'Feature', geometry: asPoly ? { type: 'Polygon', coordinates: [closeRing(pts.map(toLngLat))] } : { type: 'LineString', coordinates: pts.map(toLngLat) } });
  pts.forEach(p => f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat(p) } }));
  draftSet(f);
}
const TOOL_HELP = {
  dist: 'Click points along the line; double-click (or press Enter) to finish, Escape to cancel.',
  area: 'Click the polygon corners; double-click (or press Enter) to finish, Escape to cancel.',
  enc: 'Click the encroachment location on the map.',
  draw: 'Click the parcel corners; double-click (or press Enter) to finish, then choose the survey.',
  route: 'Click along the pipeline / road alignment; double-click (or press Enter) to finish, then choose the ROW segment.',
};
function mapTool(t) {
  GLS.tool = GLS.tool === t ? null : t; GLS.pts = []; draftSet([]);
  const ids = { dist: 'tDist', area: 'tArea', enc: 'tEnc', draw: 'tDraw', route: 'tRoute' };
  Object.entries(ids).forEach(([k, id]) => { const b = $('#' + id); if (b) { b.classList.toggle('btn-p', GLS.tool === k); b.setAttribute('aria-pressed', String(GLS.tool === k)); } });
  const map = window._map;
  if (map) { map.doubleClickZoom[GLS.tool ? 'disable' : 'enable'](); map.getCanvas().style.cursor = GLS.tool ? 'crosshair' : ''; }
  $('#mapMsg').textContent = TOOL_HELP[GLS.tool] || '';
}
function toolMessage() {
  const p = GLS.pts;
  if (GLS.tool === 'route') return `〰 Route length: <b>${fmt(pathLen(p))} m</b>`;
  if (GLS.tool === 'dist') return `📏 Distance: <b>${fmt(pathLen(p) / 1000, 3)} km</b> (${fmt(pathLen(p))} m)`;
  const ac = polyAcres(p);
  return `⬠ Area: <b>${fmt(ac, 3)} acres</b> (${ag(ac)} A-G · ${fmt(fromAcres(ac, 'Kanal'), 2)} kanal)`;
}
function mapClick(e) {
  if (!GLS.tool) return false;
  const ll = [e.lngLat.lat, e.lngLat.lng];
  if (GLS.tool === 'enc') {
    mapTool('enc');
    const sv = nearestSurvey(ll);
    openForm('encroachments', null, { lat: +ll[0].toFixed(6), lng: +ll[1].toFixed(6), surveyId: sv?.id || '', projectId: sv?.projectIds?.[0] || '', province: sv?.province || (CTX !== 'ALL' ? CTX : '') });
    return true;
  }
  const last = GLS.pts.at(-1);
  if (!last || haversine(last, ll) > 0.5) GLS.pts.push(ll);     // a double-click adds no duplicate corner
  drawDraft();
  $('#mapMsg').innerHTML = toolMessage() + ' — double-click or press Enter to finish';
  return true;
}
function mapFinish() {
  const tool = GLS.tool, pts = GLS.pts.slice(), msg = toolMessage();
  if (!tool) return;
  GLS.tool = null; mapTool(null);             // resets buttons and cursor
  if (tool === 'draw') { draftSet([]); if (pts.length < 3) { toast('A boundary needs at least 3 corners', 'warning'); return; } saveBoundary(null, pts); return; }
  if (tool === 'route') { draftSet([]); if (pts.length < 2) { toast('A route needs at least 2 points', 'warning'); return; } saveRoute(pts); return; }
  // a measurement stays on the map until cleared
  GLS.pts = pts; const keepTool = GLS.tool; GLS.tool = tool; drawDraft(); GLS.tool = keepTool;
  if (pts.length) openPopup(toLngLat(pts.at(-1)), msg);
  $('#mapMsg').innerHTML = msg + ' — “Clear drawing” removes it.';
}
function gisClear() {
  if (GLS.edit) GLS.edit.cancel();
  GLS.tool = null; GLS.pts = []; draftSet([]); mapTool(null);
  if (GLS.popup) GLS.popup.remove();
}

/* drag the corners of an existing boundary */
function editBoundary(sid) {
  const s = byId('surveys', sid), map = window._map; if (!s || !map) return;
  if (GLS.popup) GLS.popup.remove();
  let pts = s.geom && s.geom.length > 2 ? s.geom.map(p => p.slice()) : null;
  if (!pts) { const f = S.gis.flatMap(L_ => L_.features).find(f => f.surveyId === sid); pts = f ? f.geoms.find(g => g.type === 'Polygon').pts.map(p => p.slice()) : null; }
  if (!pts) { toast('This survey has no boundary yet — use “Draw parcel boundary”.', 'info'); return; }
  if (pts.length > 3 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();
  if (GLS.edit) GLS.edit.cancel();
  const redraw = () => {
    draftSet([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [closeRing(pts.map(toLngLat))] } }]);
    const b = $('#edArea'); if (b) b.textContent = fmt(polyAcres(pts), 3) + ' ac';
  };
  const markers = pts.map((p, i) => {
    const el = document.createElement('div'); el.className = 'vtx'; el.setAttribute('aria-label', 'Corner ' + (i + 1));
    return new maplibregl.Marker({ element: el, draggable: true }).setLngLat(toLngLat(p)).addTo(map)
      .on('drag', ev => { const ll = ev.target.getLngLat(); pts[i] = [ll.lat, ll.lng]; redraw(); });
  });
  const done = () => { markers.forEach(m => m.remove()); draftSet([]); GLS.edit = null; };
  GLS.edit = { cancel: () => { done(); $('#mapMsg').textContent = ''; } };
  const bb = pts.reduce((a, p) => [Math.min(a[0], p[1]), Math.min(a[1], p[0]), Math.max(a[2], p[1]), Math.max(a[3], p[0])], [180, 90, -180, -90]);
  map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 80, maxZoom: 18 });
  $('#mapMsg').innerHTML = `✏ Editing boundary of <b>${esc(s.code)}</b> — drag the corner points. Area: <b id="edArea">${fmt(polyAcres(pts), 3)} ac</b> &nbsp; <button class="btn btn-g btn-sm" id="edSave">💾 Save boundary</button> <button class="btn btn-s btn-sm" id="edCancel">Cancel</button>`;
  $('#edSave').onclick = () => { const p2 = pts.slice(); done(); saveBoundary(sid, p2); };
  $('#edCancel').onclick = () => GLS.edit.cancel();
  iconize($('#mapMsg'));
  redraw();
}

/* ---- search ------------------------------------------------------------------ */
function fitTo(features, opts) {
  const map = window._map; if (!map || !features.length) return false;
  let w = 180, s = 90, e = -180, n = -90;
  const walk = c => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  features.forEach(f => walk(f.geometry.coordinates));
  if (w > e) return false;
  if (w === e && s === n) map.flyTo(Object.assign({ center: [w, s], zoom: 15 }, opts || {}));
  else map.fitBounds([[w, s], [e, n]], Object.assign({ padding: 60, maxZoom: 16 }, opts || {}));
  return true;
}
function mapSearch() {
  const q = ($('#mapQ').value || '').trim().toLowerCase(); if (!q || !window._map) return;
  const lo = ctxRows('landowners').filter(l => (l.name + ' ' + l.cnic + ' ' + l.code).toLowerCase().includes(q)).flatMap(l => (l.shares || []).map(s => s.surveyId));
  const pj = ctxRows('projects').filter(p => (p.code + ' ' + p.name).toLowerCase().includes(q));
  const ids = new Set(ctxRows('surveys').filter(s => (s.code + ' ' + s.surveyNo + ' ' + unitPath(s.unitId)).toLowerCase().includes(q)
    || lo.includes(s.id) || pj.some(p => (s.projectIds || []).includes(p.id))).map(s => s.id));
  const hits = GLS.data.parcels.features.filter(f => ids.has(f.properties.id));
  if (!hits.length && pj[0] && pj[0].lat) { window._map.flyTo({ center: [pj[0].lng, pj[0].lat], zoom: 14 }); toast('Project ' + pj[0].code + ' located', 'success'); return; }
  if (!hits.length) { toast('No mapped parcel matches “' + q + '”', 'warning'); return; }
  fitTo(hits);
  window._map.once('moveend', () => surveyPopupAt(hits[0].properties.id));
  toast(hits.length + ' parcel(s) found', 'success');
}
function gisFly(id) {
  const f = GLS.data && GLS.data.parcels.features.find(x => x.properties.id === id);
  if (!f) return;
  fitTo([f], { maxZoom: 17 });
  window._map.once('moveend', () => surveyPopupAt(id));
  const m = $('#map'); if (m) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function gisFit() {
  const d = GLS.data; if (!d) return;
  const all = [].concat(d.parcels.features, d.fac.features, d.rows.features, d.enc.features, d.up.features);
  if (!fitTo(all, { maxZoom: 14 })) { const p = PROV[CTX]; window._map.flyTo({ center: p ? [p.center[1], p.center[0]] : [69.5, 29.5], zoom: p ? 7 : 5 }); }
}

/* ---- toolbar actions ------------------------------------------------------- */
function gisBasemap() {
  GLS.basemap = ACT_EL.value;
  const map = window._map; if (!map) return;
  Object.keys(BASEMAPS).forEach(k => map.setLayoutProperty('base-' + k, 'visibility', GLS.basemap === k ? 'visible' : 'none'));
  $('#mapMsg').textContent = GLS.basemap === 'none' ? 'Basemap off — land layers are shown on their own and need no internet connection.' : '';
}
function gisTheme() {
  GLS.theme = ACT_EL.value;
  GLS.data = buildData();
  const map = window._map;
  if (map && map.getSource('parcels')) { map.getSource('parcels').setData(GLS.data.parcels); map.getSource('dots').setData(GLS.data.dots); }
  renderLegend(); updateInView();
}
function gisLayer(k) {
  GLS.layers[k] = ACT_EL.checked;
  if (window._map) applyLayerVisibility(window._map);
  updateInView();
}
function gisTerrain() {
  const map = window._map; if (!map) return;
  GLS.terrain = !GLS.terrain;
  const btn = $('#glTerrain'); if (btn) { btn.setAttribute('aria-pressed', String(GLS.terrain)); btn.classList.toggle('btn-p', GLS.terrain); }
  applyTerrain(map, true);
}
function applyTerrain(map, animate) {
  if (GLS.terrain) {
    if (!map.getSource('dem')) map.addSource('dem', { type: 'raster-dem', tiles: TERRAIN_TILES, tileSize: 256, encoding: 'terrarium', maxzoom: 15 });
    if (!map.getSource('dem-shade')) map.addSource('dem-shade', { type: 'raster-dem', tiles: TERRAIN_TILES, tileSize: 256, encoding: 'terrarium', maxzoom: 15 });
    if (!map.getLayer('hillshade')) map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-shade', paint: { 'hillshade-exaggeration': 0.5 } }, 'enc-heat');
    map.setTerrain({ source: 'dem', exaggeration: 1.5 });
    if (animate) map.easeTo({ pitch: 60, duration: 900 });
    $('#mapMsg').textContent = '⛰ 3D terrain on — right-drag (or Ctrl + drag) to tilt and turn. Elevation needs an internet connection.';
  } else {
    map.setTerrain(null);
    if (map.getLayer('hillshade')) map.removeLayer('hillshade');
    if (animate) map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    $('#mapMsg').textContent = '';
  }
}

/* ---- building the map ------------------------------------------------------ */
function drawGIS() {
  const msg = $('#mapMsg');
  if (typeof maplibregl === 'undefined') { msg.textContent = '⚠ The map library did not load.'; return; }
  GLS.data = buildData();
  GLS.tool = null; GLS.pts = []; GLS.edit = null; GLS.labels = [];
  const p = PROV[CTX];
  let map;
  try {
    map = new maplibregl.Map({
      container: 'map', style: baseStyle(), attributionControl: { compact: true },
      center: p ? [p.center[1], p.center[0]] : [69.5, 29.5], zoom: p ? 7 : 5,
      maxPitch: 75, dragRotate: true, cooperativeGestures: false,
    });
  } catch (e) {
    msg.textContent = '⚠ This browser cannot show the GL map (WebGL is unavailable or switched off). The parcel table below still lists every parcel.';
    renderLegend(); fallbackTable();
    return;
  }
  window._map = map;
  // tile and elevation failures are expected offline: say so once, never spam the console
  let warned = false;
  map.on('error', ev => {
    const src = ev && ev.sourceId ? String(ev.sourceId) : '';
    if (!warned && (src.startsWith('base-') || src.startsWith('dem'))) {
      warned = true;
      msg.textContent = 'ℹ Basemap / elevation tiles need an internet connection — the land layers still work offline. Choose Basemap “None” to hide the empty background.';
    }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  map.on('load', () => {
    addDataLayers(map);
    if (GLS.terrain) applyTerrain(map, false);
    renderLegend();

    // hover highlight and pointer cursor
    let hovered = null;
    map.on('mousemove', 'parcels-fill', e => {
      if (GLS.tool) return;
      if (hovered !== null) map.setFeatureState({ source: 'parcels', id: hovered }, { hover: false });
      hovered = e.features[0].id; map.setFeatureState({ source: 'parcels', id: hovered }, { hover: true });
    });
    map.on('mouseleave', 'parcels-fill', () => { if (hovered !== null) map.setFeatureState({ source: 'parcels', id: hovered }, { hover: false }); hovered = null; });
    CLICKABLE.forEach(id => {
      map.on('mouseenter', id, () => { if (!GLS.tool) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { if (!GLS.tool) map.getCanvas().style.cursor = ''; });
    });

    map.on('click', e => {
      if (mapClick(e)) return;
      if (GLS.edit) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE.filter(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none') })[0];
      if (!hit) return;
      const html = popupFor(hit.layer.id, hit);
      if (html) openPopup(hit.layer.id.startsWith('parcels') ? (GLS.data.dots.features.find(f => f.properties.id === hit.properties.id) || { geometry: { coordinates: [e.lngLat.lng, e.lngLat.lat] } }).geometry.coordinates : e.lngLat, html);
    });
    map.on('dblclick', e => { if (GLS.tool) { e.preventDefault(); mapFinish(); } });
    map.on('moveend', () => { GLS.lastView = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }; updateInView(); });

    if (UI.mapFocus) {
      map.jumpTo({ center: [UI.mapFocus.lng, UI.mapFocus.lat], zoom: 15 });
      const id = UI.mapFocus.id; UI.mapFocus = null;
      if (id) setTimeout(() => surveyPopupAt(id), 300);
    } else if (GLS.lastView) {
      map.jumpTo(GLS.lastView);         // the screen re-drew after a save: stay where the user was
    } else {
      gisFit();
    }
    updateInView();
  });
}

/* WebGL unavailable: still list the parcels */
function fallbackTable() {
  const tb = $('#glInView'); if (!tb || !GLS.data) return;
  tb.innerHTML = GLS.data.dots.features.slice(0, 200).map(f => { const s = byId('surveys', f.properties.id); return s
    ? `<tr><td><a class="mono" href="${pageUrl('surveys')}?view=${encodeURIComponent(s.id)}" data-act="openView" data-a1="surveys" data-a2="${esc(s.id)}">${esc(s.code)}</a> ${esc(surveyNoTxt(s))}</td><td>${esc(unitName(s.unitId))}</td><td>${stageBadge(s.status)}</td><td>${esc(f.properties.band)}</td><td class="num">${fmt(s.totalArea, 2)}</td><td>${esc(ownersOfSurvey(s.id).map(o => o.name).join(', ') || '-')}</td></tr>` : ''; }).join('');
}

/* keyboard: Enter finishes a drawing, Escape cancels it */
document.addEventListener('keydown', e => {
  if (!GLS.tool && !GLS.edit) return;
  if (e.target.closest && e.target.closest('input, textarea, select, .mb:not(.hidden)')) return;
  if (e.key === 'Enter' && GLS.tool) { e.preventDefault(); mapFinish(); }
  if (e.key === 'Escape') { e.stopPropagation(); gisClear(); $('#mapMsg').textContent = 'Drawing cancelled.'; }
}, true);
