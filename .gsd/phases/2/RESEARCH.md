---
phase: 2
researched_at: 2026-10-15
discovery_level: 2
---

# Phase 2 Research — Landowner & Cadastral Domain Modules

## Objective
Establish rigorous data integrity rules for Pakistani landowner identification (CNIC), Islamic and statutory inheritance succession (*Wirasat / Intiqal*), fractional parcel ownership math (*Hissa-dari*), and vector geospatial ingestion.

## Key Decisions

### Decision 1: Identity & Deceased Owner Guardrails
**Question:** How should the system handle deceased landowners or disputed inheritance claims?  
**Decision:** All landowners must have a unique 13-digit CNIC formatted as `XXXXX-XXXXXXX-X`. When an owner is marked deceased, an immediate system-wide hold locks any pending compensation or lease payments. The system generates a linked title mutation (*Wirasat / Intiqal*) record requiring succession certificates issued by NADRA or civil courts and formal legal sign-off before funds can be redirected to legal heirs.  
**Confidence:** High (Directly addresses major fraud vulnerability identified by Mari Energies Land department).

### Decision 2: 100% Mathematical Parcel Share Balancing
**Question:** How to prevent ghost payments or unallocated fractional land claims?  
**Decision:** The sum of ownership percentages across all co-owners of a survey parcel must equal exactly 100.0%. Any deviation (e.g. 99.5% or 101.2%) generates a validation error that prevents compensation case submission.  
**Confidence:** High (Guarantees zero financial leakage).

### Decision 3: GIS Vector Ingestion Architecture
**Question:** How can GIS concession boundaries and flowline corridors be visualized without external internet mapping dependencies?  
**Decision:** Use MapLibre GL v3.6.2 with local vector tiles and local GeoJSON caching. Bundle JSZip v3.10.1 to decompress client-uploaded `.kmz` files in the browser and extract raw `.kml` boundary polygons without server-side processing.  
**Confidence:** High (Supports air-gapped field workstations).
