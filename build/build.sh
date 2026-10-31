#!/bin/sh
# Rebuild everything that is generated from the single-file demo.
# Hand-written sources (the stylesheets and app/assets/js/app/*.js) are
# never touched by this script — see build/README.md.
set -e
cd "$(dirname "$0")"
echo "1/3  libraries"       && python3 extract_vendor.py
echo "2/3  application code" && python3 transform_app.py
echo "3/3  pages"           && python3 generate_pages.py
echo "done"
