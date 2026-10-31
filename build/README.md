# build/

Regenerates the parts of `app/` that are derived from the single-file demo.
Run `./build.sh`, or the three steps individually.

| step | script | writes |
|---|---|---|
| 1 | `extract_vendor.py` | chart, jspdf, autotable, xlsx, jszip into `app/assets/js/vendor/` |
| 2 | `transform_app.py` | `app/assets/js/{core,ui,data}/*`, `app/assets/js/app/registry.js` |
| 3 | `generate_pages.py` | the 30 pages, as `app/<screen>/index.html` |

Source file: `../LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html`,
or set `LMS_SOURCE`.

## Not generated

These are hand-written and the build never writes to them:

- `app/assets/css/` — `tokens`, `base`, `layout`, `components`, `utilities`,
  `responsive`, `print`, `print-form`
- `app/assets/js/app/` — `session`, `scope`, `shell`, `role-ui`, `actions`,
  `a11y`, `forms`, `lazy`, `print-doc`, `boot` (but **not** `registry.js`,
  which step 2 generates)
- `app/serve.py` and `app/serve.sh`
- `app/assets/js/app/gis-map.js`, and MapLibre GL in `app/assets/js/vendor/maplibre-gl.js`
  and `app/assets/css/vendor/maplibre-gl.css` — the map, which replaced Leaflet.
  The single file still contains Leaflet; `extract_vendor.py` locates it but no
  longer writes it, and step 2 drops the Leaflet-only functions from
  `ui/gis.js` (`LEAFLET_ONLY` in `transform_app.py`), failing if any is missing.

## What step 2 does

It takes the single file's application script and rewrites it so the markup it
produces carries no behaviour or styling of its own:

- **Inline handlers → data attributes.** `onclick="openView('cases','x')"`
  becomes `data-act="openView" data-a1="cases" data-a2="x"`, dispatched by
  `app/actions.js`. 137 of them.
- **Inline styles → classes.** 123 in the app markup became utility or state
  classes; 43 inside the generated A4 documents became `p-*` classes in
  `print-form.css`.
- **Record-dependent colours → CSS custom properties** set at render time,
  so no element ever carries a `style` attribute.
- **Clickability.** Record codes, KPI tiles, alerts and list rows become real
  `<a href>` with a deep link, while keeping the in-page modal on a plain
  click.
- **Clean URLs.** Every generated link goes through `pageUrl()`, so it points
  at `/surveys` rather than `surveys.html`, relative to the page's own depth.
- **Affordances.** A control a role cannot use is emitted disabled with a
  `title` explaining why, instead of being omitted.
- **Print documents** link `print-form.css` instead of embedding a `<style>`
  block, which the pages' CSP forbids.
- **Data scope.** The audit trail, document register, notifications and
  dashboard activity read through `visibleAudit()` / `visibleDocs()` /
  `noteVisible()` instead of the raw collections; record sub-tables skip rows
  that point outside the viewer's province access (display only).
- **Module split** at the original file's own section boundaries.

It then emits `registry.js` — the allowlist of functions the dispatcher may
call — from the `data-act` values actually present in the output, so the table
cannot drift from the markup.

## It fails rather than guess

The script stops with a message if:

- the source file's app script is not 2580 lines (the split is line-based);
- any `on…=` handler survives the conversion;
- a `style` attribute it has no mapping for appears;
- any of its literal replacements no longer matches the source;
- a replacement would change the line count.

So after editing the single file, run the build: a silent mismatch is not a
possible outcome, but you may need to add a mapping.

## Checking a build

`build.sh` is idempotent — running it twice gives byte-identical output.
To confirm a change did what you expected:

```sh
cp -R app /tmp/before && ./build/build.sh && diff -r /tmp/before app
```
