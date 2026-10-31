#!/usr/bin/env python3
"""
Serve this folder so the URLs are clean: /surveys rather than surveys.html.

Uses only the standard library, but unlike `python3 -m http.server` it speaks
HTTP/1.1 with keep-alive and serves each request on its own thread. A page
pulls in about two dozen files, and the stock one-liner opens a fresh
connection for every one of them, which makes it drop requests under load.

    ./serve.py          # http://localhost:8000
    ./serve.py 8080     # a different port
"""
import functools
import http.server
import os
import socketserver
import sys
import webbrowser


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'          # keep-alive, so one connection serves many files

    def do_GET(self):
        clean_path = self.path.split('?')[0]
        if clean_path.endswith('.map') or clean_path.startswith('/.well-known/') or '/sourceMap/' in clean_path:
            translated = self.translate_path(self.path)
            if not os.path.exists(translated):
                self.send_response(204)
                self.end_headers()
                return
        super().do_GET()

    do_HEAD = do_GET

    def end_headers(self):
        # a demo should always show the current build, never a cached one
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        # keep the console quiet apart from problems
        status = args[1] if len(args) > 1 else ''
        if str(status).startswith(('4', '5')):
            sys.stderr.write('  %s %s\n' % (status, args[0] if args else ''))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(Handler, directory=root)
    url = 'http://localhost:%d/' % port

    try:
        server = Server(('127.0.0.1', port), handler)
    except OSError as e:
        sys.exit('Cannot listen on port %d (%s). Try: ./serve.py %d' % (port, e.strerror, port + 1))

    print('Land Management System  ->  %s' % url)
    print('Press Ctrl-C to stop.')
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
