'use client';

// GIS land map in the reference's layout (legacy-demo/assets/js/app/gis-map.js:
// .maptools, .gl-wrap with #map and .gl-side, MapLibre GL on the same version).
// Survey parcels come from /api/gis; uploaded KML/KMZ layers, merges and
// uploads from /api/gis/kml and /api/gis/kml/merge. The table of features
// below the map is the text alternative to it.
//
// Land requests (migration 0057): the "Land requests" layer shows the latest
// polygon of every request the user may see, coloured by stage. Someone who
// may raise requests draws one here ("Draw land request"): corners by click,
// drag, typed or pasted lat/long, or a KML file. /gis?request=<id> frames a
// request; /gis?edit=<id> opens a draft or returned request for a new version.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Map as MLMap, GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Loading, ErrorNote, fmtNum } from '@/components/legacy/ui';
import { PAL } from '@/components/legacy/ChartBox';
import { send } from '@/lib/client/api';
import { useCan } from '@/lib/client/permissions';
import type { LngLat } from '@/lib/geo';
import { closeRing } from '@/lib/geo';
import { DrawPanel, RequestFormModal, previewOf, type AreaSource, type EditTarget } from '@/components/gis/LandRequestDrawer';

// Parcel colours by land status, as the reference's dashboard and map use them.
const STATUS_COLOURS: Record<string, string> = {
  Proposed: PAL.grey, 'Under Acquisition': PAL.amber, Acquired: PAL.green, Leased: PAL.blue, Disputed: PAL.red,
};
const KML_COLOUR = PAL.purple;
const DRAW_COLOUR = '#e0521a';
// Land-request polygons by stage (plan section 5.3).
const REQUEST_COLOURS: [string, string][] = [
  ['Draft', PAL.grey], ['Under review', PAL.amber], ['Returned', '#c9a400'], ['Approved', PAL.green], ['Handed over', PAL.blue], ['Rejected', PAL.red],
];
const stageGroup = (s: string) => (['Submitted', 'Under Review - Ops', 'Under Review - Regional', 'Under Review - Land Affairs'].includes(s) ? 'Under review' : s);
const REQUEST_COLOUR_EXPR: any = ['match', ['get', 'group'], ...REQUEST_COLOURS.flat(), PAL.grey];
const PAKISTAN: [number, number] = [69.3, 30.0];

type Basemap = 'streets' | 'satellite' | 'none';

// The reference offers OpenStreetMap and Esri World Imagery (satellite).
function baseStyle(basemap: Basemap): StyleSpecification {
  const sources: StyleSpecification['sources'] =
    basemap === 'streets' ? { base: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors', maxzoom: 19 } }
    : basemap === 'satellite' ? { base: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, attribution: 'Imagery © Esri', maxzoom: 19 } }
    : {};
  return {
    version: 8,
    sources,
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e9eef4' } },
      ...(basemap !== 'none' ? [{ id: 'base', type: 'raster' as const, source: 'base' }] : []),
    ],
  };
}

function coordsOf(g: any): [number, number][] {
  if (!g) return [];
  if (typeof g[0] === 'number') return [g as [number, number]];
  return (g as any[]).flatMap(coordsOf);
}

export default function GisPage() {
  return (
    <Shell>
      <GisContent />
    </Shell>
  );
}

function GisContent() {
  const { activeProvince, permissions } = useLMS();
  const can = useCan();
  const canUpload = permissions.includes('gis:create');
  const canReadRequests = can('requests:read');
  const canDraw = can(['requests:create', 'projects:read']);
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [surveys, setSurveys] = useState<any>({ type: 'FeatureCollection', features: [] });
  const [features, setFeatures] = useState<any[]>([]);
  const [kmlImports, setKmlImports] = useState<any[]>([]);
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);
  const [merges, setMerges] = useState<any[]>([]);
  const [showSurveys, setShowSurveys] = useState(true);
  const [basemap, setBasemap] = useState<Basemap>('streets');
  const [selected, setSelected] = useState<{ kind: 'survey' | 'feature' | 'request'; props: any } | null>(null);
  // Land requests layer and drawing.
  const [reqGeo, setReqGeo] = useState<any>({ type: 'FeatureCollection', features: [] });
  const [showRequests, setShowRequests] = useState(true);
  const [showClosed, setShowClosed] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [corners, setCornersState] = useState<LngLat[]>([]);
  const [drawSource, setDrawSource] = useState<AreaSource>('draw');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'g' | 'd'; text: React.ReactNode } | null>(null);
  const drawingRef = useRef(false);
  const cornersRef = useRef<LngLat[]>([]);
  const setCorners = (c: LngLat[]) => { cornersRef.current = c; setCornersState(c); };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapMsg, setMapMsg] = useState<string | null>(null);

  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [customLayerName, setCustomLayerName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeSuccess, setMergeSuccess] = useState<any | null>(null);

  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [mapReady, setMapReady] = useState(0);
  // True between a style's 'style.load' and the next setStyle(). map.isStyleLoaded() is not
  // used: it stays false while basemap tiles are still downloading, so on first load the
  // land layers were skipped and only appeared after something re-ran the effect.
  const styleReady = useRef(false);
  const handlersOn = useRef(false);

  const canProjects = permissions.includes('projects:read');
  useEffect(() => {
    if (!canProjects) { setLoading(false); return; }   // the project picker needs projects:read
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => {
        if (d.projects?.length) {
          setProjects(d.projects);
          setSelectedProjectId(d.projects[0].project_id);
        }
      })
      .catch(console.error);
  }, [canProjects]);

  useEffect(() => {
    fetch(`/api/gis${activeProvince !== 'ALL' ? `?province=${activeProvince}` : ''}`)
      .then((r) => r.json())
      .then((d) => { if (d.features) setSurveys(d); })
      .catch(console.error);
  }, [activeProvince]);

  const refreshRequests = () => {
    if (!canReadRequests) return;
    fetch(`/api/requests?geo=1${activeProvince !== 'ALL' ? `&province=${activeProvince}` : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.features) setReqGeo(d); })
      .catch(console.error);
  };
  useEffect(refreshRequests, [activeProvince, canReadRequests]);

  const startDrawing = (target: EditTarget | null, ring: LngLat[] = []) => {
    setSelected(null); setNotice(null); setEditing(target); setCorners(ring); setDrawSource('draw');
    drawingRef.current = true; setDrawing(true);
    mapRef.current?.doubleClickZoom.disable();
  };
  const stopDrawing = () => {
    drawingRef.current = false; setDrawing(false); setEditing(null); setCorners([]); setFormOpen(false);
    mapRef.current?.doubleClickZoom.enable();
  };

  const refreshGisData = () => {
    if (!selectedProjectId) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      fetch(`/api/gis/kml?projectId=${selectedProjectId}`).then((r) => r.json()),
      fetch(`/api/gis/kml/merge?projectId=${selectedProjectId}`).then((r) => r.json()),
    ])
      .then(([kmlRes, mergeRes]) => {
        setFeatures(kmlRes.features || []);
        setKmlImports(kmlRes.imports || []);
        setSelectedImportIds((kmlRes.imports || []).map((i: any) => i.id));
        setMerges(mergeRes.merges || []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };
  useEffect(() => { refreshGisData(); }, [selectedProjectId]);

  const visibleFeatures = useMemo(
    () => features.filter((f) => !f.import_id || selectedImportIds.includes(f.import_id)),
    [features, selectedImportIds]);

  const kmlGeo = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: visibleFeatures.filter((f) => f.coordinates && f.geometry_type).map((f) => ({
      type: 'Feature' as const,
      id: undefined,
      geometry: { type: f.geometry_type, coordinates: f.coordinates },
      properties: { fid: f.id, name: f.feature_name, type: f.geometry_type, acres: Number(f.area_acres || 0), merged: !!f.is_merged },
    })),
  }), [visibleFeatures]);

  const visibleRequests = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: (reqGeo.features as any[])
      .filter((f) => f.properties.id !== editing?.id)
      .filter((f) => showClosed || f.properties.stage !== 'Rejected')
      .map((f) => ({ ...f, properties: { ...f.properties, group: stageGroup(f.properties.stage) } })),
  }), [reqGeo, editing, showClosed]);

  const drawGeo = useMemo(() => {
    const pts = corners.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    const fs: any[] = pts.map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { i } }));
    if (pts.length >= 2) fs.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.length >= 3 ? closeRing(pts) : pts }, properties: {} });
    if (pts.length >= 3) fs.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [closeRing(pts)] }, properties: {} });
    return { type: 'FeatureCollection' as const, features: fs };
  }, [corners]);

  // Create the map once; restyle when the basemap changes.
  useEffect(() => {
    let cancelled = false;
    // OpenStreetMap refuses browser tile requests that carry no Referer. The app's
    // policy is same-origin (no Referer cross-site), and a client-side navigation
    // here never receives next.config's /gis header, so relax it for this page
    // only — origin only, never path or query — before MapLibre (and its worker)
    // load, and restore it on the way out.
    const setReferrerPolicy = (v: string) => {
      const m = document.createElement('meta');
      m.name = 'referrer'; m.content = v;
      document.head.appendChild(m);
      return m;
    };
    const relaxed = setReferrerPolicy('strict-origin-when-cross-origin');
    (async () => {
      const maplibregl = (await import('maplibre-gl')).default;
      if (cancelled || !mapEl.current) return;
      const map = new maplibregl.Map({ container: mapEl.current, style: baseStyle(basemap), center: PAKISTAN, zoom: 4.6, attributionControl: { compact: true } });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      map.on('error', (e: any) => {
        if (String(e?.error?.message || '').match(/tile|fetch|Failed/i))
          setMapMsg('Basemap tiles need an internet connection — the land layers still work offline. Choose Basemap “None” to hide the empty background.');
      });
      map.on('style.load', () => { styleReady.current = true; setMapReady((n) => n + 1); });
      mapRef.current = map;
    })();
    return () => {
      cancelled = true; mapRef.current?.remove(); mapRef.current = null;
      // A removed <meta> does not undo its policy; inserting the app default does.
      relaxed.remove();
      setReferrerPolicy('same-origin').remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    styleReady.current = false;   // sources and layers are re-added on the new style's 'style.load'
    map.setStyle(baseStyle(basemap)); setMapMsg(null);
  }, [basemap]);

  // (Re)add the land layers whenever the style or the data changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !styleReady.current) return;
    const put = (id: string, data: any) => {
      const src = map.getSource(id) as GeoJSONSource | undefined;
      if (src) src.setData(data); else map.addSource(id, { type: 'geojson', data });
    };
    put('kml', kmlGeo);
    put('surveys', surveys);
    put('requests', visibleRequests);
    put('draw', drawGeo);
    if (!map.getLayer('kml-fill')) {
      map.addLayer({ id: 'req-fill', type: 'fill', source: 'requests', paint: { 'fill-color': REQUEST_COLOUR_EXPR, 'fill-opacity': 0.22 } });
      map.addLayer({ id: 'req-line', type: 'line', source: 'requests', paint: { 'line-color': REQUEST_COLOUR_EXPR, 'line-width': 2.5, 'line-dasharray': [3, 1.5] } });
      map.addLayer({ id: 'kml-fill', type: 'fill', source: 'kml', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': KML_COLOUR, 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'kml-line', type: 'line', source: 'kml', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': KML_COLOUR, 'line-width': 2 } });
      map.addLayer({ id: 'kml-pt', type: 'circle', source: 'kml', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': KML_COLOUR, 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
      map.addLayer({
        id: 'surveys-pt', type: 'circle', source: 'surveys',
        paint: {
          'circle-color': ['match', ['get', 'status'], ...Object.entries(STATUS_COLOURS).flat(), PAL.teal] as any,
          'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
        },
      });
      // The polygon being drawn, on top of everything.
      map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': DRAW_COLOUR, 'fill-opacity': 0.2 } });
      map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': DRAW_COLOUR, 'line-width': 2.5 } });
      map.addLayer({ id: 'draw-pt', type: 'circle', source: 'draw', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-color': '#fff', 'circle-radius': 6, 'circle-stroke-color': DRAW_COLOUR, 'circle-stroke-width': 2.5 } });
    }
    // Layer event handlers survive setStyle(), so they are registered once.
    if (!handlersOn.current) {
      handlersOn.current = true;
      for (const l of ['kml-fill', 'kml-line', 'kml-pt']) {
        map.on('click', l, (e: any) => { if (!drawingRef.current) setSelected({ kind: 'feature', props: e.features?.[0]?.properties }); });
        map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
      }
      map.on('click', 'surveys-pt', (e: any) => { if (!drawingRef.current) setSelected({ kind: 'survey', props: e.features?.[0]?.properties }); });
      map.on('mouseenter', 'surveys-pt', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'surveys-pt', () => { map.getCanvas().style.cursor = drawingRef.current ? 'crosshair' : ''; });
      map.on('click', 'req-fill', (e: any) => { if (!drawingRef.current) setSelected({ kind: 'request', props: e.features?.[0]?.properties }); });
      map.on('mouseenter', 'req-fill', () => { if (!drawingRef.current) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'req-fill', () => { map.getCanvas().style.cursor = drawingRef.current ? 'crosshair' : ''; });

      // Drawing: a click on the map adds a corner (a click on an existing corner does not).
      map.on('click', (e: any) => {
        if (!drawingRef.current) return;
        if (map.queryRenderedFeatures(e.point, { layers: ['draw-pt'] }).length) return;
        const c = cornersRef.current;
        if (c.length >= 500) return;
        const next: LngLat[] = [...c, [Math.round(e.lngLat.lng * 1e7) / 1e7, Math.round(e.lngLat.lat * 1e7) / 1e7]];
        cornersRef.current = next; setCornersState(next); setDrawSource('draw');
      });
      // Dragging a corner moves it.
      let dragIdx: number | null = null;
      const onMove = (e: any) => {
        if (dragIdx === null) return;
        const next = cornersRef.current.map((p, i) => (i === dragIdx ? [Math.round(e.lngLat.lng * 1e7) / 1e7, Math.round(e.lngLat.lat * 1e7) / 1e7] as LngLat : p));
        cornersRef.current = next; setCornersState(next);
      };
      const onUp = () => { dragIdx = null; map.dragPan.enable(); map.off('mousemove', onMove); map.getCanvas().style.cursor = drawingRef.current ? 'crosshair' : ''; };
      map.on('mousedown', 'draw-pt', (e: any) => {
        if (!drawingRef.current) return;
        e.preventDefault();
        dragIdx = Number(e.features?.[0]?.properties?.i);
        map.dragPan.disable(); map.getCanvas().style.cursor = 'grabbing';
        map.on('mousemove', onMove); map.once('mouseup', onUp);
      });
      map.on('mouseenter', 'draw-pt', () => { if (drawingRef.current) map.getCanvas().style.cursor = 'move'; });
      map.on('mouseleave', 'draw-pt', () => { if (drawingRef.current && dragIdx === null) map.getCanvas().style.cursor = 'crosshair'; });
    }
    map.setLayoutProperty('surveys-pt', 'visibility', showSurveys ? 'visible' : 'none');
    map.setLayoutProperty('req-fill', 'visibility', showRequests ? 'visible' : 'none');
    map.setLayoutProperty('req-line', 'visibility', showRequests ? 'visible' : 'none');
    map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
  }, [mapReady, kmlGeo, surveys, showSurveys, visibleRequests, drawGeo, showRequests, drawing]);

  const fitAll = () => {
    const map = mapRef.current;
    if (!map) return;
    const pts = [
      ...(showSurveys ? surveys.features.map((f: any) => f.geometry.coordinates) : []),
      ...kmlGeo.features.flatMap((f) => coordsOf(f.geometry.coordinates)),
      ...(showRequests ? visibleRequests.features.flatMap((f: any) => coordsOf(f.geometry.coordinates)) : []),
      ...corners,
    ].filter((p: any) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
    if (!pts.length) { map.flyTo({ center: PAKISTAN, zoom: 4.6 }); return; }
    const xs = pts.map((p: any) => p[0]), ys = pts.map((p: any) => p[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 50, maxZoom: 14, duration: 600 });
  };
  // Frame the data the first time it arrives.
  const framed = useRef(false);
  useEffect(() => {
    if (!framed.current && mapReady && (surveys.features.length || kmlGeo.features.length)) { framed.current = true; fitAll(); }
  }, [mapReady, surveys, kmlGeo]);

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile || !selectedProjectId) return;
    setUploading(true);
    setUploadMsg(null);
    const formData = new FormData();
    formData.append('file', uploadFile);
    formData.append('projectId', selectedProjectId);
    if (customLayerName) formData.append('layerName', customLayerName);
    try {
      const data = await send<any>('POST', '/api/gis/kml', formData);
      setUploadMsg({ type: 'success', text: `Imported ${data.featureCount} feature(s) from “${data.filename}”.` });
      setUploadFile(null);
      setCustomLayerName('');
      framed.current = false;
      refreshGisData();
      setTimeout(() => { setIsUploadOpen(false); setUploadMsg(null); }, 1500);
    } catch (err: any) {
      setUploadMsg({ type: 'error', text: err.message });
    } finally {
      setUploading(false);
    }
  };

  const handleExecuteMerge = async () => {
    if (!selectedProjectId || selectedImportIds.length === 0) return;
    setMerging(true);
    setMergeSuccess(null);
    setError(null);
    try {
      const data = await send<any>('POST', '/api/gis/kml/merge', { projectId: selectedProjectId, importIds: selectedImportIds });
      setMergeSuccess(data);
      refreshGisData();
    } catch (err: any) {
      setError(`Merge failed: ${err.message}`);
    } finally {
      setMerging(false);
    }
  };

  // Keyboard and screen-reader access to the same selection the map's click gives (UX-11).
  const panTo = (coords: [number, number][]) => {
    const map = mapRef.current;
    const pts = coords.filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
    if (!map || !pts.length) return;
    if (pts.length === 1) { map.flyTo({ center: pts[0], zoom: Math.max(map.getZoom(), 13), duration: 600 }); return; }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 50, maxZoom: 15, duration: 600 });
  };
  // /gis?request=<id> frames a request; /gis?edit=<id> opens it for a new polygon version.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !mapReady || !canReadRequests) return;
    deepLinked.current = true;
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get('edit') || sp.get('request');
    if (!id) return;
    fetch(`/api/requests?id=${encodeURIComponent(id)}`).then((r) => r.json()).then((d) => {
      if (!d.request) { setNotice({ tone: 'd', text: d.error || 'That land request was not found.' }); return; }
      const ring: LngLat[] = d.areas?.[0]?.geometry?.coordinates?.[0]?.slice(0, -1) ?? [];
      framed.current = true;
      if (sp.get('edit')) {
        if (!d.request.is_mine || !['Draft', 'Returned'].includes(d.request.stage_code))
          setNotice({ tone: 'd', text: `${d.request.code} can be changed only by its requester while it is a draft or returned.` });
        else startDrawing({ id: d.request.id, code: d.request.code, stage: d.request.stage_code, request: d.request }, ring);
      } else {
        setSelected({ kind: 'request', props: { id: d.request.id, code: d.request.code, stage: d.request.stage_code, purpose: d.request.purpose,
          project_code: d.request.project_code, area_acres: Number(d.areas?.[0]?.area_acres ?? d.request.area_acres), version: d.areas?.[0]?.version,
          waiting_on: d.request.pending_approver_role } });
      }
      if (ring.length) panTo(ring);
    }).catch(console.error);
  }, [mapReady, canReadRequests]);

  const preview = useMemo(() => previewOf(corners, surveys, reqGeo, editing?.id ?? null), [corners, surveys, reqGeo, editing]);
  const projectsInScope = editing ? projects.filter((p) => p.province_code === editing.request.province_code) : projects;
  const onSaved = (r: any, submitted: boolean) => {
    const was = editing;
    stopDrawing();
    refreshRequests();
    setNotice({ tone: 'g', text: <>{was ? `Saved a new version of ${r.code}` : `Created ${r.code}`}{submitted ? ' and sent it to Director Operations.' : ' as a draft (only you can see it).'}{' '}
      <a href={`/requests?open=${r.id}`}>Open in Land Requests</a></> });
  };
  const requestRows = visibleRequests.features as any[];

  const showFeature = (f: any) => {
    setSelected({ kind: 'feature', props: { name: f.feature_name, type: f.geometry_type, acres: f.area_acres, merged: !!f.is_merged } });
    panTo(coordsOf(f.coordinates));
  };
  const showParcel = (f: any) => {
    setSelected({ kind: 'survey', props: f.properties });
    panTo(coordsOf(f.geometry?.coordinates));
  };
  const PARCEL_ROWS = 200;
  const parcels = surveys.features as any[];

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of surveys.features) c[f.properties.status] = (c[f.properties.status] || 0) + 1;
    return c;
  }, [surveys]);

  return (
    <>
      <Card icon="pin" title="GIS land map"
        sub="Survey parcels by land status and the project's uploaded KML / KMZ layers. Click a feature for its record.">
        <div className="maptools">
          <label className="gl-field"><span className="note">Project </span>
            <select className="sel" value={selectedProjectId} onChange={(e) => { framed.current = false; setSelectedProjectId(e.target.value); }}>
              {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name} ({p.province_code})</option>)}
            </select>
          </label>
          <label className="gl-field"><span className="note">Basemap </span>
            <select className="sel" value={basemap} onChange={(e) => setBasemap(e.target.value as Basemap)}>
              <option value="streets">Streets</option><option value="satellite">Satellite imagery</option><option value="none">None (works offline)</option>
            </select>
          </label>
          <button className="btn btn-s btn-sm" onClick={fitAll}>⤢ Show all</button>
          <span className="grow u-flex-1" />
          {canDraw && !drawing && <button className="btn btn-p btn-sm" onClick={() => startDrawing(null)}>✎ Draw land request</button>}
          {canUpload && <button className="btn btn-g btn-sm" onClick={() => { setUploadMsg(null); setIsUploadOpen(true); }}>Upload KML / KMZ</button>}
          <button className="btn btn-s btn-sm" onClick={() => { framed.current = false; refreshGisData(); }}>Refresh</button>
        </div>
        {mapMsg && <div className="note u-mb-6" role="status">{mapMsg}</div>}
        {notice && <div className={`al ${notice.tone === 'g' ? 'i' : 'd'} u-mb-6`} role="status"><span className="i" /><div className="tx">{notice.text}</div></div>}
        {drawing && <div className="al w u-mb-6" role="status"><span className="i" /><div className="tx">Drawing mode: click the map to add corners. The panel on the right shows the area, the lat/long of every corner and the parcels inside.</div></div>}
        <div className={`gl-wrap${drawing ? ' drawing' : ''}`}>
          <div id="map" ref={mapEl} role="region" aria-label="Interactive land map. The tables of survey parcels and features below list the same items as text, each with a Show button." />
          <aside className="gl-side" aria-label={drawing ? 'Land request drawing' : 'Map layers and legend'}>
            {drawing ? (
              <DrawPanel corners={corners} setCorners={setCorners} source={drawSource} setSource={setDrawSource}
                surveys={surveys} requests={reqGeo} editing={editing}
                onCancel={stopDrawing} onContinue={() => setFormOpen(true)} />
            ) : <>
            <h4>Layers</h4>
            <label className="gl-check">
              <input type="checkbox" checked={showSurveys} onChange={(e) => setShowSurveys(e.target.checked)} /> Survey parcels <span className="note">{surveys.features.length}</span>
            </label>
            {kmlImports.map((imp) => (
              <label key={imp.id} className="gl-check">
                <input type="checkbox" checked={selectedImportIds.includes(imp.id)}
                  onChange={(e) => setSelectedImportIds(e.target.checked ? [...selectedImportIds, imp.id] : selectedImportIds.filter((id) => id !== imp.id))} />
                {imp.layer_name} <span className="note">{imp.feature_count}</span>
              </label>
            ))}
            {!kmlImports.length && <p className="note">No KML layers for this project.</p>}
            {canReadRequests && <>
              <label className="gl-check">
                <input type="checkbox" checked={showRequests} onChange={(e) => setShowRequests(e.target.checked)} /> Land requests <span className="note">{visibleRequests.features.length}</span>
              </label>
              <label className="gl-check">
                <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Include rejected requests
              </label>
            </>}
            <h4>Legend</h4>
            <div className="gl-legend">
              {Object.entries(STATUS_COLOURS).map(([s, c]) => (
                <div key={s}><i style={{ background: c }} />{s} <span className="note">{statusCounts[s] || 0}</span></div>
              ))}
              <div><i style={{ background: KML_COLOUR }} />Uploaded KML <span className="note">{kmlGeo.features.length}</span></div>
            </div>
            {canReadRequests && <>
              <h4>Land requests</h4>
              <div className="gl-legend">
                {REQUEST_COLOURS.map(([s, c]) => (
                  <div key={s}><i style={{ background: c }} />{s} <span className="note">{requestRows.filter((f) => f.properties.group === s).length}</span></div>
                ))}
              </div>
            </>}
            <h4 id="glSelected">Selected</h4>
            <div role="status" aria-live="polite" aria-labelledby="glSelected">
            {!selected && <p className="note">Click a parcel or feature on the map, or use Show in the tables below.</p>}
            {selected?.kind === 'survey' && (
              <div className="dl">
                <div><small>Survey</small><span className="code">{selected.props.code}</span></div>
                <div><small>Status</small><span><Stage value={selected.props.status} /></span></div>
                <div><small>Area</small><span>{fmtNum(selected.props.total_area_acres, 2)} acres</span></div>
                <div><small>Owner shares</small><span>{fmtNum(selected.props.share_total_pct, 1)}% · {selected.props.owner_count} owner(s)</span></div>
                <div><small>Location</small><span>{selected.props.location || '—'}</span></div>
              </div>
            )}
            {selected?.kind === 'feature' && (
              <div className="dl">
                <div><small>Feature</small><span>{selected.props.name}</span></div>
                <div><small>Geometry</small><span>{selected.props.type}</span></div>
                <div><small>Area</small><span>{fmtNum(selected.props.acres, 2)} acres</span></div>
                <div><small>Merge</small><span>{String(selected.props.merged) === 'true' ? 'In a merged layer' : 'Independent layer'}</span></div>
              </div>
            )}
            {selected?.kind === 'request' && (
              <div className="dl">
                <div><small>Land request</small><span className="code">{selected.props.code}</span></div>
                <div><small>Stage</small><span><Stage value={selected.props.stage} /></span></div>
                <div><small>Purpose</small><span>{selected.props.purpose}</span></div>
                <div><small>Project</small><span>{selected.props.project_code}</span></div>
                <div><small>Drawn area</small><span>{fmtNum(selected.props.area_acres, 2)} acres{selected.props.version ? ` · version ${selected.props.version}` : ''}</span></div>
                {selected.props.waiting_on && !['None', 'Completed'].includes(selected.props.waiting_on) && <div><small>Waiting on</small><span>{selected.props.waiting_on}</span></div>}
                <div><span><a className="btn btn-s btn-sm" href={`/requests?open=${selected.props.id}`}>Open request</a></span></div>
              </div>
            )}
            </div>
            </>}
          </aside>
        </div>
      </Card>

      <div className="grid2">
        <Card icon="layers" title="KML layers & merge" sub="Combine selected layers into one validated dataset and download it as KML">
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="bar">
            <button className="btn btn-p btn-sm" onClick={handleExecuteMerge} disabled={!canUpload || merging || selectedImportIds.length === 0}
              title={canUpload ? undefined : 'Your role cannot merge layers'}>
              {merging ? 'Merging…' : `Merge selected layers (${selectedImportIds.length})`}
            </button>
          </div>
          {mergeSuccess && (
            <div className="al i" role="status"><span className="i" /><div className="tx">
              Merged {mergeSuccess.featureCount} feature(s) · {mergeSuccess.totalAreaAcres} acres
              <small><a href={mergeSuccess.downloadUrl} download>Download merged KML</a></small>
            </div></div>
          )}
          <Table caption="Merged layers" head={<><th>Merged layer</th><th className="num">Features</th><th className="num">Acres</th><th>File</th></>}
            empty={merges.length ? false : 'No merged layers yet.'} colSpan={4}>
            {merges.map((m) => (
              <tr key={m.id}>
                <td>{m.merge_name}</td>
                <td className="num">{fmtNum(m.feature_count)}</td>
                <td className="num">{fmtNum(m.total_area_acres, 2)}</td>
                <td><a href={`/api/gis/kml/merge?mergeId=${m.id}&download=true`} download>Download KML</a></td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card icon="map" title="Features in this project" sub="The same features the map shows, as a table">
          {loading ? <Loading what="features" /> : (
            <Table caption="Spatial features" head={<><th>Feature</th><th>Geometry</th><th className="num">Acres</th><th>Source</th><th><span className="sr-only">Actions</span></th></>}
              empty={visibleFeatures.length ? false : 'No KML features imported for this project yet.'} colSpan={5}>
              {visibleFeatures.map((f) => (
                <tr key={f.id}>
                  <td>{f.feature_name}</td>
                  <td><span className="pill">{f.geometry_type}</span></td>
                  <td className="num">{fmtNum(f.area_acres, 2)}</td>
                  <td>{f.source_file || <span className="note">—</span>}</td>
                  <td><button type="button" className="btn btn-s btn-sm" onClick={() => showFeature(f)}
                    aria-label={`Show feature ${f.feature_name} on the map`}>Show</button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {canReadRequests && (
        <Card icon="clip" title="Land requests on the map" sub="The latest polygon of each land request you can see, as a table">
          <Table caption="Land requests on the map" head={<><th>Request</th><th>Stage</th><th>Purpose</th><th>Project</th><th className="num">Acres</th><th><span className="sr-only">Actions</span></th></>}
            empty={requestRows.length ? false : 'No land request has a polygon yet.'} colSpan={6}>
            {requestRows.map((f) => (
              <tr key={f.properties.id}>
                <td className="code">{f.properties.code}{f.properties.version > 1 && <small className="note"> v{f.properties.version}</small>}</td>
                <td><Stage value={f.properties.stage} /></td>
                <td>{f.properties.purpose}</td>
                <td>{f.properties.project_code}</td>
                <td className="num">{fmtNum(f.properties.area_acres, 2)}</td>
                <td><button type="button" className="btn btn-s btn-sm" onClick={() => { setSelected({ kind: 'request', props: f.properties }); panTo(coordsOf(f.geometry.coordinates)); }}
                  aria-label={`Show land request ${f.properties.code} on the map`}>Show</button></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card icon="map" title="Survey parcels on the map"
        sub={parcels.length > PARCEL_ROWS
          ? `The first ${PARCEL_ROWS} of ${parcels.length.toLocaleString()} parcels the map shows; find others in the Survey / Khasra register.`
          : 'The parcels the map shows, as a table.'}>
        <Table caption="Survey parcels" head={<><th>Survey</th><th>Status</th><th className="num">Acres</th><th className="num">Owners</th><th>Location</th><th><span className="sr-only">Actions</span></th></>}
          empty={parcels.length ? false : 'No survey parcels with a location in this province.'} colSpan={6}>
          {parcels.slice(0, PARCEL_ROWS).map((f, i) => (
            <tr key={f.properties?.id ?? f.properties?.code ?? i}>
              <td className="code">{f.properties?.code}</td>
              <td><Stage value={f.properties?.status} /></td>
              <td className="num">{fmtNum(f.properties?.total_area_acres, 2)}</td>
              <td className="num">{fmtNum(f.properties?.owner_count)}</td>
              <td>{f.properties?.location || <span className="note">—</span>}</td>
              <td><button type="button" className="btn btn-s btn-sm" onClick={() => showParcel(f)}
                aria-label={`Show survey ${f.properties?.code ?? ''} on the map`}>Show</button></td>
            </tr>
          ))}
        </Table>
      </Card>

      {formOpen && (
        <RequestFormModal key={editing?.id ?? 'new'} open={formOpen} corners={corners} source={drawSource} editing={editing}
          projects={projectsInScope} preview={preview} onClose={() => setFormOpen(false)} onSaved={onSaved} />
      )}

      <Modal open={isUploadOpen} size="sm" icon="up" title="Upload KML / KMZ" onClose={() => setIsUploadOpen(false)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setIsUploadOpen(false)}>Cancel</button>
          <button type="submit" form="kmlForm" className="btn btn-p" disabled={uploading || !uploadFile}>{uploading ? 'Validating…' : 'Upload'}</button>
        </>}>
        {uploadMsg && (uploadMsg.type === 'error'
          ? <ErrorNote>{uploadMsg.text}</ErrorNote>
          : <div className="al i" role="status"><span className="i" /><div className="tx">{uploadMsg.text}</div></div>)}
        <form id="kmlForm" onSubmit={handleUploadSubmit}>
          <Field label="Project" required htmlFor="kmlProj">
            <select id="kmlProj" value={selectedProjectId} onChange={(e) => setSelectedProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
            </select>
          </Field>
          <Field label="Layer name" htmlFor="kmlName">
            <input id="kmlName" type="text" placeholder="e.g. Well-01 lease boundary" value={customLayerName} onChange={(e) => setCustomLayerName(e.target.value)} />
          </Field>
          <Field label="File" required htmlFor="kmlFile" hint="Points, lines and polygons. External entities and archive path traversal are refused.">
            <input id="kmlFile" type="file" accept=".kml,.kmz" required onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
          </Field>
        </form>
      </Modal>
    </>
  );
}
