/* GIS data — parcel popup, boundary/route saving, KML/KMZ/GeoJSON import (map: app/gis-map.js)
   Part of the LMS multi-page build. Loaded as a classic script;
   top-level declarations are shared across the bundle. */
/* =====================================================================
   GIS (SoW §3.1) — Leaflet map, layers, search, measurement, KML/KMZ/GeoJSON upload
   ===================================================================== */
const ST_COL = { Proposed: '#8a9bb0', 'Under Acquisition': '#e09a1a', Acquired: '#16a061', Leased: '#2368b0', Disputed: '#d93a3a' };
const PT_COL = { 'Well Location': '#111827', 'Pipeline Area': '#7a4fc2', 'Camp Area': '#1597a6', 'Compressor Area': '#b45309', 'Access Road': '#6b7280', 'Gathering Station': '#7a4fc2', 'Processing Facility': '#b45309' };
let MAPST = { tool: null, pts: [], tmp: null, layers: {} };
function polyAcres(pts) { // planar approximation on local equirectangular projection — adequate for parcel-size polygons
  if (!pts || pts.length < 3) return 0; const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length * Math.PI / 180; const R = 6378137;
  const xy = pts.map(([la, lo]) => [lo * Math.PI / 180 * R * Math.cos(lat0), la * Math.PI / 180 * R]); let s = 0;
  for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2 / 4046.8564224;
}
function surveyPopup(s) {
  const owners = ownersOfSurvey(s.id);
  const cs = S.cases.filter(c => (c.leaseLines || []).some(l => l.surveyId === s.id) && c.stage !== 'Cancelled');
  const ls = S.leases.filter(l => (l.surveyIds || []).includes(s.id));
  const paid = sum(S.payments.filter(p => p.stage === 'Released' && (cs.some(c => c.id === p.caseId) || ls.some(l => l.id === p.leaseId))), 'net');
  return `<b>${esc(s.code)}</b> · ${esc(PROV[s.province].rev)} <b>${esc(surveyNoTxt(s))}</b><br><small>${esc(unitPath(s.unitId))}</small><hr class="u-hr">
  Status: <b data-color="${esc(ST_COL[s.status] || '')}">${esc(s.status)}</b> · ${esc(s.landClass)}<br>Total: ${esc(areaTxt(s.totalArea, s.province))}<br>Occupied: ${esc(areaTxt(occupiedArea(s.id), s.province))}<br>
  Owners: ${owners.map(o => esc(o.name) + ' (' + fmt(o.shares.find(x => x.surveyId === s.id).share, 0) + '%)').join(', ') || '-'}<br>Projects: ${esc((s.projectIds || []).map(projCode).join(', ') || '-')}<br>
  Cases: ${cs.map(c => esc(c.code)).join(', ') || '-'} · Leases: ${ls.map(l => esc(l.code)).join(', ') || '-'}<br>Paid to date: <b>${rs(paid)}</b><br>${s.geom ? 'GIS boundary area: ' + fmt(polyAcres(s.geom), 3) + ' ac<br>' : ''}<a href="${pageUrl('surveys')}?view=${encodeURIComponent(s.id)}" data-act="openView" data-a1="surveys" data-a2="${s.id}">Open land record ›</a>${can.create() ? ` · <button class="as-link" data-act="editBoundary" data-a1="${s.id}">Edit boundary</button>` : ''}`;
}
async function saveBoundary(sid, pts) {
  const ac = polyAcres(pts); let id = sid;
  if (!id) { const near = nearestSurvey(pts[0]); const v = await dialog({ title: 'Save drawn boundary', html: `<p class="note">Drawn area ≈ <b>${fmt(ac, 3)} acres</b> (${ag(ac)} A-G).</p><div class="fg u-mt-8"><label>Survey / khasra this boundary belongs to</label><select data-k="s">${ctxRows('surveys').filter(s => !s._vol).map(s => `<option value="${s.id}" ${near && near.id === s.id ? 'selected' : ''}>${esc(LABEL.surveys(s))} — record ${fmt(s.totalArea, 2)} ac</option>`).join('')}</select></div>`, ok: 'Save boundary' }); if (!v) return; id = v.s; }
  const s = byId('surveys', id); if (!s) return; const before = { geom: s.geom || null, lat: s.lat, lng: s.lng };
  s.geom = pts.map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]); s.lat = +(pts.reduce((a, p) => a + p[0], 0) / pts.length).toFixed(6); s.lng = +(pts.reduce((a, p) => a + p[1], 0) / pts.length).toFixed(6);
  pushHist(s, 'Boundary ' + (before.geom ? 'edited' : 'drawn') + ' on GIS (' + fmt(ac, 3) + ' ac)', s.status, s.status); audit('surveys', s, 'GIS boundary ' + (before.geom ? 'edited' : 'drawn'), before, { geom: s.geom, lat: s.lat, lng: s.lng }); persist();
  const diff = num(s.totalArea) ? (ac - num(s.totalArea)) / num(s.totalArea) * 100 : 0;
  toast(`Boundary saved for ${s.code}: GIS area ${fmt(ac, 3)} ac vs record ${fmt(s.totalArea, 3)} ac (${diff >= 0 ? '+' : ''}${fmt(diff, 1)}%)`, Math.abs(diff) > 10 ? 'warning' : 'success'); render();
}
async function saveRoute(pts) {
  const len = Math.round(pathLen(pts)); const R = ctxRows('rows');
  const v = await dialog({ title: 'Save ROW route', html: `<p class="note">Route length ≈ <b>${fmt(len)} m</b>.</p><div class="fg u-mt-8"><label>ROW segment</label><select data-k="r">${R.map(r => `<option value="${r.id}">${esc(r.code + ' — ' + r.name)} (record ${fmt(r.lengthM)} m)</option>`).join('')}</select></div><div class="fg u-mt-8"><label>Update recorded length to the drawn length?</label><select data-k="u"><option value="1">Yes — set length = ${fmt(len)} m</option><option value="0">No — keep recorded length</option></select></div>`, ok: 'Save route' });
  if (!v || !v.r) return; const r = byId('rows', v.r); const before = { path: r.path, lengthM: r.lengthM };
  r.path = pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join('; '); if (v.u === '1') r.lengthM = len;
  pushHist(r, 'Route drawn on GIS (' + fmt(len) + ' m)', r.stage, r.stage); audit('rows', r, 'GIS route drawn', before, { path: r.path, lengthM: r.lengthM }); persist(); toast('Route saved for ' + r.code + ' — ROW area ' + fmt(rowInfo(r).area, 3) + ' ac', 'success'); render();
}
/* ---- GIS file upload ---- */
function parseKML(text) {
  const xml = new DOMParser().parseFromString(text, 'text/xml'); if (xml.getElementsByTagName('parsererror').length) throw new Error('Invalid KML (XML parse error)');
  const pts = el => (el?.textContent || '').trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(a => a.length >= 2 && !isNaN(a[0]) && !isNaN(a[1])).map(([lng, lat]) => [lat, lng]);
  return [...xml.getElementsByTagName('Placemark')].map(pm => {
    const geoms = [];
    [...pm.getElementsByTagName('Point')].forEach(g => geoms.push({ type: 'Point', pts: pts(g.getElementsByTagName('coordinates')[0]) }));
    [...pm.getElementsByTagName('LineString')].forEach(g => geoms.push({ type: 'LineString', pts: pts(g.getElementsByTagName('coordinates')[0]) }));
    [...pm.getElementsByTagName('Polygon')].forEach(g => { const ob = g.getElementsByTagName('outerBoundaryIs')[0] || g; geoms.push({ type: 'Polygon', pts: pts(ob.getElementsByTagName('coordinates')[0]) }); });
    return { name: pm.getElementsByTagName('name')[0]?.textContent?.trim() || 'Feature', desc: (pm.getElementsByTagName('description')[0]?.textContent || '').replace(/<[^>]+>/g, ' ').trim(), geoms: geoms.filter(g => g.pts.length) };
  }).filter(f => f.geoms.length);
}
function parseGeoJSON(text) {
  const j = JSON.parse(text); const feats = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [{ geometry: j, properties: {} }];
  const sw = c => c.map(([lng, lat]) => [lat, lng]);
  return feats.map(f => { const g = f.geometry || {}; const geoms = []; const t = g.type;
    if (t === 'Point') geoms.push({ type: 'Point', pts: sw([g.coordinates]) }); else if (t === 'LineString') geoms.push({ type: 'LineString', pts: sw(g.coordinates) }); else if (t === 'Polygon') geoms.push({ type: 'Polygon', pts: sw(g.coordinates[0]) });
    else if (t === 'MultiPolygon') g.coordinates.forEach(p => geoms.push({ type: 'Polygon', pts: sw(p[0]) })); else if (t === 'MultiLineString') g.coordinates.forEach(l => geoms.push({ type: 'LineString', pts: sw(l) }));
    const pr = f.properties || {}; return { name: pr.name || pr.Name || pr.title || 'Feature', desc: Object.entries(pr).map(([k, v]) => k + ': ' + v).join('; '), geoms }; }).filter(f => f.geoms.length);
}
async function gisUpload(file) {
  if (!file) return;
  try {
    let feats; const n = file.name.toLowerCase();
    if (n.endsWith('.kmz')) { const zip = await JSZip.loadAsync(file); const k = Object.keys(zip.files).find(x => x.toLowerCase().endsWith('.kml')); if (!k) throw new Error('No .kml inside KMZ'); feats = parseKML(await zip.files[k].async('string')); }
    else if (n.endsWith('.kml')) feats = parseKML(await file.text());
    else feats = parseGeoJSON(await file.text());
    if (!feats.length) throw new Error('No features found');
    const Lr = { id: uid(), code: nextCode('GIS-', 4), name: file.name, at: nowStr(), user: ME.username, features: feats };
    // auto-link polygons whose name contains an existing survey code / survey number
    let auto = 0; feats.forEach(f => { const s = S.surveys.find(sv => f.name.toUpperCase().includes(sv.code.toUpperCase())); if (s && f.geoms.some(g => g.type === 'Polygon')) { f.surveyId = s.id; const c = f.geoms.find(g => g.type === 'Polygon').pts; s.lat = +(c.reduce((a, p) => a + p[0], 0) / c.length).toFixed(6); s.lng = +(c.reduce((a, p) => a + p[1], 0) / c.length).toFixed(6); auto++; } });
    S.gis.push(Lr); audit('gis', Lr, 'GIS file uploaded', null, { file: file.name, features: feats.length }); attachMeta(Lr, file); persist();
    toast(`${feats.length} feature(s) loaded from ${file.name}${auto ? ' · ' + auto + ' auto-linked to surveys' : ''}`, 'success'); render();
  } catch (e) { toast('GIS upload failed: ' + e.message, 'error'); }
}
function attachMeta(Lr, file) { S.documents.push({ id: uid(), code: nextCode('DOC-', 5), coll: 'gis', recId: Lr.id, recCode: Lr.code, name: file.name, size: file.size, type: file.type || 'application/vnd.google-earth', category: 'GIS File', version: 1, uploadedBy: ME.username, at: nowStr(), deleted: false, stored: false, history: [{ at: nowStr(), user: ME.username, action: 'Uploaded (GIS layer)' }] }); }
async function gisLink(lid, i) {
  const Lr = S.gis.find(x => x.id === lid); const f = Lr.features[i];
  const v = await dialog({ title: 'Link “' + f.name + '” to a survey', html: `<div class="fg"><label>Survey / Khasra</label><select data-k="s"><option value="">— none —</option>${ctxRows('surveys').map(s => `<option value="${s.id}" ${f.surveyId === s.id ? 'selected' : ''}>${esc(LABEL.surveys(s))}</option>`).join('')}</select><small>The polygon becomes this parcel's boundary on the map. Polygon area ≈ ${fmt(polyAcres(f.geoms.find(g => g.type === 'Polygon').pts), 3)} ac.</small></div>` });
  if (!v) return; S.gis.forEach(x => x.features.forEach(ff => { if (ff.surveyId === v.s && ff !== f) ff.surveyId = null; })); f.surveyId = v.s || null;
  if (v.s) { const s = byId('surveys', v.s); const c = f.geoms.find(g => g.type === 'Polygon').pts; s.lat = +(c.reduce((a, p) => a + p[0], 0) / c.length).toFixed(6); s.lng = +(c.reduce((a, p) => a + p[1], 0) / c.length).toFixed(6); audit('surveys', s, 'Boundary linked from ' + Lr.name); }
  persist(); toast('Boundary link updated', 'success'); render();
}
async function gisDel(lid) { const Lr = S.gis.find(x => x.id === lid); if (!(await confirmBox('Remove GIS layer?', 'Remove “' + esc(Lr.name) + '” and its ' + Lr.features.length + ' feature(s) from the map?', 'Remove'))) return; S.gis = S.gis.filter(x => x.id !== lid); audit('gis', Lr, 'GIS layer removed', { file: Lr.name }, null); persist(); render(); }
function sampleKML() {
  const sv = ctxRows('surveys').filter(s => s.lat).slice(0, 3); const box = (s, d) => { const la = s.lat, lo = s.lng; return `${lo - d},${la - d},0 ${lo + d},${la - d},0 ${lo + d},${la + d},0 ${lo - d},${la + d},0 ${lo - d},${la - d},0`; };
  const pm = sv.map((s, i) => `<Placemark><name>${s.code} Survey ${esc(s.surveyNo)} boundary</name><description>Sample boundary for ${s.code}</description><Polygon><outerBoundaryIs><LinearRing><coordinates>${box(s, 0.0016 + i * 0.0004)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`).join('');
  const s0 = sv[0] || { lat: 28.05, lng: 69.65 };
  const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>LMS sample boundaries</name>${pm}<Placemark><name>Sample proposed access road</name><LineString><coordinates>${s0.lng - 0.01},${s0.lat - 0.008},0 ${s0.lng},${s0.lat},0</coordinates></LineString></Placemark></Document></kml>`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' })); a.download = 'LMS_sample_boundaries.kml'; a.click();
  toast('Sample KML downloaded — upload it to see parcels auto-linked by survey code', 'info');
}
