# Exploration Land Request on the GIS Map — Proposal (v2)

**Status:** **Phase 1 built on 31 Oct 2026** (migration 0057), with parts of Phase 2: the parcels inside, the warnings, and the Land Officer hand-over with parcels marked "Under Acquisition". Decided: **both the Exploration Planner and the Land Officer may raise requests.** Not yet built: pre-filled acquisition, lease or case records; lines; PostGIS. Test guide: [docs/testing/EXPLORATION_LAND_REQUEST_TEST_GUIDE.md](../testing/EXPLORATION_LAND_REQUEST_TEST_GUIDE.md).
Implementation differs from the text below in two places: drawing is hand-written on MapLibre (no Terra Draw or Turf dependency; `src/lib/geo.ts`), and `regmgrqta` and `landaffqta` were added so Balochistan has a full chain.
**Date:** 31 Oct 2026 (v2: role decision and the full flow added)
**System:** Mari Energies LMS (Next.js 15, PostgreSQL, MapLibre GIS)

---

## 1. Decisions in this version

| Question | Decision proposed |
|---|---|
| A separate module, or link to Land Requests? | **Link to Land Requests.** The polygon becomes part of the land request. The approval chain, separation of duties, audit trail and inbox already exist there. |
| Who draws the polygon? | A **new role, "Exploration Planner"**. This is the "Initiator" the land-request workflow already names (`api/requests/[id]/transition`: *Initiator → Director Operations → Regional Manager → DM / TL Land Affairs*) but that no role represents today. |
| Who approves? | The three approval positions that already exist. They are filled by **three new reviewer accounts** under one new role, **"Land Request Reviewer"**, plus the existing land team for the last tier. |
| What happens after approval? | The **Land Officer** of the province takes over and turns the approved polygon into land records (acquisition, lease or compensation case). |

---

## 2. Summary

The exploration team marks the land it needs directly on the GIS map: a polygon
whose corners are latitude/longitude points (well site, camp, access road area).
The polygon is submitted as a **Land Request** and passes the existing three-tier
approval:

**Director Operations → Regional Manager → DM / TL Land Affairs**

Each reviewer sees the polygon on the map with its area, location and the parcels
(khasras) it covers, and approves, returns it for changes, or rejects it. Once it
is approved, the province's Land Officer starts the acquisition or lease from it.

**Is it possible?** Yes. A polygon is a closed list of latitude/longitude points.
Each click on the map adds a corner with its own coordinates. The same polygon can
be typed in or pasted (from a field GPS), or uploaded as KML. The system computes
the area, the centre point and the parcels inside.

---

## 3. What the system already has

| Area | Status today |
|---|---|
| Land Requests (`lms.land_request`, `/requests`) | Built. Form: project, concession block, purpose, required area (acres, ghunta), target deh, required by, priority, justification. Tiers: Submitted → Under Review (Regional) → Under Review (Land Affairs) → Approved; Return and Reject carry a comment; a returned request is resubmitted only by its requester. A parcel can be allocated on approval. |
| Rules already enforced in the database | The requester cannot approve; one person cannot decide two tiers; only the holder of a tier's position decides it, and only in their provinces. |
| Who may create land requests | data-entry (Land Officer), negotiation-officer, case-approver, land-manager. |
| Who may approve | case-approver, land-manager, **and only if they hold the tier's position**. **No account holds any of the three positions**, so no request can be approved today. |
| Land described as | Text only. There is no shape on a map. |
| GIS map (`/gis`) | MapLibre map, survey markers (one point per khasra), KML upload. KML polygons are stored in `lms.project_spatial_feature`. An area function exists in `src/lib/kml.ts`. |
| Drawing on the map | Not available. |
| Khasra boundaries | Not stored. A khasra has a single lat/long point. |
| PostGIS | Not installed. |

---

## 4. Roles

### 4.1 Recommended roles

| Role (new or existing) | Account(s) | Province | Approval position | Can do |
|---|---|---|---|---|
| **Exploration Planner** (new) | `explorer` (SND), `explorerqta` (BAL) | own province(s) | — (initiator) | Draw, edit and submit land-request polygons; see own requests and their status; GIS map; projects; parcel locations and land status. **No** landowner names or CNIC, no payments, no approvals. |
| **Land Request Reviewer** (new) | `dirops` | all | Director Operations | Read land requests and their polygons on the map; approve, return or reject the Director Operations tier. Read parcels and land status. No landowner personal data. |
| | `regmgr` | own region (e.g. SND) | Regional Manager | Same, for the Regional Manager tier |
| DM / TL Land Affairs (existing land team) | `landaffairs` (new account, role **case-approver**) | own province | DM / TL Land Affairs | Final tier: checks whether the land can be obtained (owners, private or government, litigation, existing leases). Sees landowner data because the role already allows it. |
| Land Officer (existing, data-entry) | `lofield` … | own province | Land Officer (Field) | After approval: creates the acquisition, lease or case from the polygon. Can also raise a land request, as today. |
| Manager Land HO, Audit, Admin (existing) | `mland`, `audit`, `admin` | all | — | See all requests and polygons, read-only (audit, and admin via the map layer only if decided). |

### 4.2 Why a new role instead of using the Land Officer

- **Separation of duties.** The person who asks for land should not be the person who later acquires it and raises its payments. The Land Officer does both today; a separate initiator keeps the request independent.
- **Least privilege.** An exploration planner needs the map and the request, not landowner CNICs, bank details or payments.
- **It matches the workflow.** The code already names an "Initiator" ahead of Director Operations; the new role fills that slot.

### 4.3 Permissions of the new roles

| Permission | Exploration Planner | Land Request Reviewer |
|---|---|---|
| `requests:read` | own requests (scope "assigned") | province / all |
| `requests:create` | yes | — |
| `requests:approve` | — | yes (decides only the tier whose position they hold) |
| `gis:read`, `projects:read` | yes | yes |
| `surveys:read` (location, area, land status) | yes | yes |
| `landowners:read`, `pii:read` | **no** | **no** |
| payments, cases, leases | no | no |

---

## 5. The full flow

### 5.1 States

```
                 ┌──────────── Return (comment) ─────────────┐
                 ▼                                            │
 Draft ──Submit──► Submitted ──► Under Review ──► Under Review ──► Approved ──► Handed over
   ▲              (Director Ops)  (Regional Mgr)  (Land Affairs)        │        (Land Officer
   │                    │               │               │               │         starts work)
   └─ Returned ◄────────┴───────────────┴───────────────┘               │
        │ edit polygon/form, resubmit (new version)                     │
        └─ Withdraw                         any tier: Reject ──► Rejected (closed)
```

`Draft` and `Handed over` are new. The rest exist today.

### 5.2 Step by step

| # | Who | Where | What happens | System does |
|---|---|---|---|---|
| 1 | Exploration Planner | GIS map → **New land request** | Chooses the project, then **draws the polygon** (or pastes GPS corners, or uploads KML). Can draw more than one shape if the business allows it (well site + road + camp). | Shows the corner table (lat/long), area in acres and in the province's unit, centre point, and the province / district / deh. Lists the parcels inside and **warnings**: already acquired or leased, disputed, under a stay order, government land, overlaps another open request. |
| 2 | Exploration Planner | Same panel | Fills purpose (well site, access road, camp, seismic line), required by, priority, justification. **Save as draft** or **Submit**. | Validates: shape closed, no self-crossing, inside the chosen province, area within limits. Saves the polygon as version 1. Code `REQ-2026-0001`. |
| 3 | Director Operations (`dirops`) | Approvals & Alerts, or the map layer | Opens the request: polygon on the map, corner table, area, parcels, warnings. Decides whether the **operational need** is real. | Approve → moves to Regional Manager. Return → back to the planner with the comment. Reject → closed. Every decision is recorded with name, time and comment. |
| 4 | Regional Manager (`regmgr`) | Same | Decides whether the **region** supports it (budget, schedule, other activity nearby). | As above. |
| 5 | DM / TL Land Affairs (`landaffairs`) | Same | Decides whether the **land can be obtained**: owners, private or government, litigation, existing leases. May allocate a parcel. | Approve → **Approved**. |
| 5a | Exploration Planner | If returned | Edits the polygon or the form and resubmits. | Saves version 2; versions 1 and 2 are both kept and can be compared on the map. The request goes back to Director Operations. |
| 6 | Land Officer of the province (`lofield`) | Notified in Approvals & Alerts | Opens the approved request and clicks **Start land work**, choosing an acquisition, a lease or a compensation case. | Parcels inside the polygon are marked **Under Acquisition**. The chosen record opens pre-filled with the project, parcels, owners and area. Government land is routed to DBPFC. The request becomes **Handed over** and links to the new record. |
| 7 | All | Map and request page | Track progress. | The polygon stays on the map in its final colour, linked to the acquisition, lease or case. |

### 5.3 What each person sees on the map

| Person | "Land requests" layer |
|---|---|
| Exploration Planner | Own requests, every stage |
| Director Operations | Requests waiting for them, and all requests in their scope |
| Regional Manager / Land Affairs | Requests of their provinces |
| Land Officer | Approved requests of their province |
| Manager Land HO, Audit | All requests, read-only |

Polygon colours: Draft (grey), Submitted / Under review (orange), Returned (yellow), Approved (green), Handed over (blue), Rejected (red, hidden by default).

---

## 6. Entering latitude and longitude

1. **Draw on the map.** Each click places a corner; a double-click closes the shape. Corners can be dragged and deleted.
2. **Type or paste coordinates** from a field GPS:

| # | Latitude | Longitude |
|---|---|---|
| 1 | 28.03100 | 69.32850 |
| 2 | 28.03100 | 69.33300 |
| 3 | 28.02700 | 69.33300 |
| 4 | 28.02700 | 69.32850 |

3. **Upload KML/KMZ** (the parser already exists).

The corner table is shown for every polygon and is printed with the request.

---

## 7. Technical approach

| Decision | Recommendation |
|---|---|
| Drawing tool | **Terra Draw** (native MapLibre adapter: polygon, line, point; edit, snap, delete). |
| Storage | New table **`lms.land_request_area`**: request, version, shape type, GeoJSON geometry, corners, area (m², acres), centre lat/lng, drawn by, time. One row per version. Same row-level security as `land_request`. |
| New columns on `land_request` | `stage` gains `Draft` and `Handed over`; `handed_over_to` (link to the acquisition, lease or case). |
| Spatial maths | **Turf.js** in phase 1 (area, point-in-polygon, self-intersection), re-checked on the server. **PostGIS** in phase 3 for overlaps and true parcel boundaries. |
| Units | Store m² and acres; display the province unit through `lms.unit_conversion`. |
| Security | `protect()` on every route, province RLS, CSRF, one audit row per change, separation of duties already enforced in `lms.tg_land_request_sod` and `lms.tg_land_request_tier`. |

---

## 8. Delivery phases

| Phase | Scope | Outcome |
|---|---|---|
| **1 — MVP** | Two new roles and five demo accounts; positions assigned; draw / edit / paste / upload polygon; corner table; area and centre; Draft stage; "Land requests" map layer; existing 3-tier approval with return, edit and versions | A planner sends a polygon; three reviewers decide on the map |
| **2 — Link to land records** | Parcels inside, warnings, overlap with other open requests (point-based); Land Officer hand-over creating a pre-filled acquisition, lease or case; parcels marked Under Acquisition | The land team starts work straight from the approved request |
| **3 — Full GIS** | PostGIS; true polygon overlaps; khasra boundaries from KML; corridor lines with a width (pipelines, seismic); KML/GeoJSON export | Accurate spatial checks across the portfolio |

---

## 9. Questions still open for the business

1. Confirm the new role: **Exploration Planner** as the only initiator, or may Land Officers still raise requests as they can today? (Proposal: both may.)
2. Who are the real Director Operations and Regional Manager users, and which provinces does each cover?
3. Can one request hold several shapes (well site + road + camp)?
4. Are lines needed as well as polygons (pipelines, seismic), with a width?
5. What should the hand-over create: an acquisition, a lease, or a compensation case, or the Land Officer's choice?
6. Should the planner see landowner names? (Proposal: no; only private / government / disputed.)
7. Minimum and maximum area for a request?

---

## 10. Risks and notes

- **Parcel matching is approximate until phase 3.** A khasra is one point, so "inside the polygon" means its point is inside.
- **The three approval positions must be filled** before any request can be approved; today no one holds them.
- **Map tiles need the internet** (OpenStreetMap / Esri). Drawing and saving work offline, on a blank background.
