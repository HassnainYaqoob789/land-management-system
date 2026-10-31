# Exploration Land Request on the GIS Map — Test Guide

**Built:** 31 Oct 2026 (migration 0057). Plan: [EXPLORATION_LAND_REQUEST_GIS_PLAN.md](../plans/EXPLORATION_LAND_REQUEST_GIS_PLAN.md).
**Database:** `lms_dev` is at 0057 and has the seven new demo accounts.
**Before testing:** run `npm run build`, then restart the server on port 3040. The new accounts appear on the sign-in page (demo mode) with their passwords.

---

## 1. Who is who

| Account | Name | Role | Province | What they do |
|---|---|---|---|---|
| `explorer` | Usman Ghani | **Exploration Planner** (new) | Sindh | Draws the land on the map and raises the request |
| `explorerqta` | Kamran Bugti | Exploration Planner | Balochistan | Same, for Balochistan |
| `lofield` | Sanaullah Khoso | Land Officer (existing) | Sindh | **Can also raise requests**, and takes an approved request up ("Start land work") |
| `dirops` | Javed Akhtar | **Land Request Reviewer** (new), Director Operations position | All | Tier 2 decision |
| `regmgr` | Sadia Memon | Land Request Reviewer, Regional Manager position | Sindh | Tier 3 decision |
| `regmgrqta` | Naseer Kakar | Land Request Reviewer, Regional Manager position | Balochistan | Tier 3 decision |
| `landaffairs` | Zubair Soomro | case-approver, DM / TL Land Affairs position | Sindh | Tier 4 (final) decision |
| `landaffqta` | Gul Bano Rind | case-approver, DM / TL Land Affairs position | Balochistan | Tier 4 (final) decision |

A Balochistan chain works the same way: `explorerqta` → `dirops` → `regmgrqta` → `landaffqta` → `loquetta`.

## 2. The flow

```
explorer (draws, Draft or Submit) → dirops → regmgr → landaffairs → APPROVED → lofield "Start land work" → HANDED OVER
            ▲                         │         │          │
            └──────── Return (with a comment): the planner redraws, a new version is saved, and sends it again
```

## 3. Step-by-step test (Sindh)

### Step 1 — Exploration Planner draws the land (`explorer`)
1. Sign in as `explorer`. You land on **GIS Land Map**: the planner has no dashboard.
2. Check the menu: GIS map, Projects, Survey register, Land Requests. **No** Landowners, Payments or Cases.
3. Click **✎ Draw land request**. The cursor becomes a cross.
4. Click 4–6 points on the map around a survey marker. A corner appears at each click and the orange polygon closes by itself.
   - **Drag** a corner to move it.
   - **Undo corner** / **Clear** work.
   - The right panel shows each corner's **latitude and longitude** (you can type over them), the **area** (acres and hectares), the **centre point** and the **parcels inside**.
   - Warnings appear when a disputed, acquired, leased or government parcel is inside, or when the shape overlaps another open request.
5. Try **Paste lat/long** with this text, then **Use these corners**:
   ```
   28.03100, 69.32850
   28.03100, 69.33300
   28.02700, 69.33300
   28.02700, 69.32850
   ```
6. Optional: **Load KML** with any .kml file that has a polygon.
7. Negative check: make the edges cross (a bow-tie). You get "The boundary crosses itself" and **Continue** is disabled.
8. Click **Continue: request details**. Choose the project and purpose, then click **Save as draft**.
   - Expected: "Created REQ-2026-xxxx as a draft (only you can see it)". The polygon is grey on the map.

### Step 2 — The draft is private
- Sign in as `dirops` or `lofield` → **Land Requests**. The draft does **not** appear.

### Step 3 — The planner edits and sends it (`explorer`)
1. **Land Requests** → on the draft, click **Edit on map**. The polygon opens in drawing mode. Move a corner.
2. Click **Continue**, fill in the **Justification** and "What changed", then **Save and send to Director Operations**.
3. **Details** shows **Polygon versions v2 and v1**, with who drew each and when. The stage is Submitted (orange on the map).
4. **Edit on map** is no longer offered: a submitted request is locked.

### Step 4 — Director Operations (`dirops`)
1. **Land Requests** → **Details**: decisions, polygon versions, corners (lat/long), parcels inside, warnings.
2. Click **Map** to see the polygon on the GIS map, then **Open request** in the side panel.
3. Click **Review** → **Approve** with a comment. The stage becomes "Under Review - Regional".
4. Negative check: `regmgr` and `landaffairs` see no **Review** button at the Submitted stage (not their tier). `regmgrqta` (Balochistan) cannot see the Sindh request at all.

### Step 5 — Regional Manager returns it (`regmgr`)
1. **Review** → **Return** with the comment "move the pad 100 m east".
2. Sign in as `explorer`. The request shows **Returned**, with **Edit on map**, **Send** and **Withdraw**.
3. Edit on map, move the polygon, then **Save and send**. Polygon **v3** is saved and the request goes back to Director Operations.
4. `dirops` approves again, then `regmgr` approves.

### Step 6 — Land Affairs gives the final approval (`landaffairs`)
- **Review** → **Approve**. The stage is **Approved** (green on the map), and the workflow column reads "5. Land work" as current.

### Step 7 — The Land Officer takes it up (`lofield`)
1. **Land Requests** → **Start land work**.
2. Choose **Acquisition** (or Lease, Compensation case, DBPFC). Tick "Mark the recorded parcels inside … Under Acquisition" and add a comment.
3. Expected: the stage is **Handed over** (blue on the map), and a message lists the parcels marked. In the **Survey / Khasra Register**, those khasras now show **Under Acquisition**.
4. Negative check: `explorer` and `dirops` do not get the **Start land work** button. The server also refuses it (403).

### Step 8 — The Land Officer raises a request too (`lofield`)
- **Land Requests** → **✎ Draw a land request on the map** → draw → **Submit to Director Operations**. Both the Exploration Planner and the Land Officer can raise requests.
- **+ Add without a map** still works, as before.

## 4. Quick checklist

| # | Check | Expected |
|---|---|---|
| 1 | `explorer` opens /landowners | No access |
| 2 | Bow-tie polygon | Refused ("crosses itself") |
| 3 | Corner outside Pakistan (e.g. lat 50) | Refused |
| 4 | Draft seen by `dirops` | Not listed |
| 5 | `regmgr` approves a Submitted request | No button; the API answers 403 |
| 6 | `regmgrqta` opens a Sindh request | Not found |
| 7 | Returned → redraw | New version; older versions kept |
| 8 | Edit after submitting | Refused (409) |
| 9 | `dirops` hands over | Refused (403) |
| 10 | Hand-over with "mark parcels" | Proposed khasras inside become Under Acquisition |

## 5. What was verified by the developer (31 Oct 2026)

| Gate | Command / place | Result |
|---|---|---|
| Typecheck, lint | `npx tsc --noEmit`, `npx eslint` (changed files) | PASSED |
| Unit (incl. 10 new geo tests) | `npm run test:unit` (DATABASE_URL = lms_test) | PASSED 42/42 |
| DB suite (clean rebuild of `lms_test` with 0057) | `python db/tools/run_tests.py --db lms_test` | PASSED 23/23, 842 assertions |
| New API flow test | `tests/regression/land_request_gis.test.ts` on a test build (port 3041, `lms_iam_test`) | PASSED 10/10 |
| Full API suite | `npm run test:api` on port 3041 | 1480 passed, 2 failed, 34 skipped. The failures are not land-request code: two need the test IdP (not running), and one fixture's session expiry check |
| UI in a browser | Playwright (Chromium) on port 3041 | PASSED: explorer lands on the map, draws, submits; dirops opens Details and the polygon on the map |

## 6. Known limits (Phase 3 in the plan)

- A khasra is one point. "Inside" means the khasra's point is inside the polygon; true boundaries need PostGIS and parcel boundaries.
- One polygon per request. No lines with a width (pipelines, seismic) yet.
- "Start land work" records the hand-over and marks parcels. The acquisition, lease or case is then created in its own register; it is not pre-filled yet.
- Land requests are not in **Approvals & Alerts**. Reviewers work from **Land Requests**.
