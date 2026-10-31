#!/bin/sh
# Serve this folder so the URLs are clean (/surveys rather than surveys.html).
exec python3 "$(dirname "$0")/serve.py" "$@"
