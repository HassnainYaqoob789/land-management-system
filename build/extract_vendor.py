#!/usr/bin/env python3
"""
Pull the bundled third-party libraries (and Leaflet's stylesheet) out of the
single-file build and write them to app/assets/{js/vendor,css/vendor}.

The single file concatenated six libraries into one <script> block. They are
located here by their licence banners rather than by line number, so the
script keeps working if the source file shifts.

Nothing is modified: each file is a byte-for-byte copy of its slice.
Leaflet is located (it is part of the bundle) but not written — the map
is MapLibre GL now, which is not in the single file and is vendored as is.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
candidate_paths = [
    os.environ.get('LMS_SOURCE'),
    os.path.join(ROOT, "LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html"),
    os.path.join(ROOT, "requirments", "LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html")
]
SRC = next((p for p in candidate_paths if p and os.path.exists(p)), candidate_paths[1])

JS_OUT = os.path.join(ROOT, 'app', 'assets', 'js', 'vendor')
CSS_OUT = os.path.join(ROOT, 'app', 'assets', 'css', 'vendor')

# found in the single file but no longer used by the multi-page build
RETIRED = {'leaflet.js'}

# (output file, a string unique to that library's banner)
LIBRARIES = [
    ('chart.umd.js',              '* Chart.js v'),
    ('jspdf.umd.min.js',          '* jsPDF - PDF Document creation from JavaScript'),
    ('jspdf.plugin.autotable.js', 'jsPDF AutoTable plugin'),
    ('xlsx.full.min.js',          'xlsx.js (C) 2013-present SheetJS'),
    ('leaflet.js',                '* Leaflet 1.9.4'),
    ('jszip.min.js',              'JSZip v3.10.1'),
]


def main():
    html = open(SRC, encoding='utf-8').read()

    # the libraries live in the FIRST <script> block; the app code is the last
    i = html.index('<script>')
    j = html.index('</script>', i)
    bundle = html[i + len('<script>'):j]

    # find where each library starts, backing up to the top of its comment
    marks = []
    for name, banner in LIBRARIES:
        at = bundle.find(banner)
        if at < 0:
            sys.exit('could not find %s (banner %r)' % (name, banner))
        start = bundle.rfind('/*', 0, at)
        marks.append((start if start >= 0 else at, name))
    marks.sort()

    if len(marks) != len(LIBRARIES):
        sys.exit('expected %d libraries, located %d' % (len(LIBRARIES), len(marks)))

    os.makedirs(JS_OUT, exist_ok=True)
    os.makedirs(CSS_OUT, exist_ok=True)

    total = 0
    for n, (start, name) in enumerate(marks):
        end = marks[n + 1][0] if n + 1 < len(marks) else len(bundle)
        body = bundle[start:end]
        if name in RETIRED:
            continue
        open(os.path.join(JS_OUT, name), 'w', encoding='utf-8').write(body)
        total += len(body)
        print('  %-28s %9d bytes' % (name, len(body)))

    # Leaflet (and its stylesheet, the first <style> block) is located but no
    # longer written: the map is MapLibre GL, vendored separately as
    # app/assets/js/vendor/maplibre-gl.js — see build/README.md.
    for stale in (os.path.join(JS_OUT, 'leaflet.js'), os.path.join(CSS_OUT, 'leaflet.css')):
        if os.path.exists(stale):
            os.remove(stale)
    print('  %-28s %9d bytes total' % ('', total))


if __name__ == '__main__':
    main()
