#!/bin/sh
# The app is static ES modules — it needs an origin, not a build step.
#
#   ./serve.sh                 http://localhost:8080, this machine only
#   ./serve.sh 9000            a different port
#   ./serve.sh 8080 0.0.0.0    also reachable from phones/laptops on your network
#
# Unlike plain `python3 -m http.server` this sends Cache-Control: no-store, so a
# reload always picks up edited modules instead of a cached copy.
#
# If the optional API server is running (server/karaoke.mjs, port 8090 by
# default, or $KARAOKE_API), /api/* is forwarded to it — so the app can be served
# from here and still search your own scores. With nothing there, /api/* answers
# 503 and the app carries on without a server, which is its normal state.
PORT="${1:-8080}"
HOST="${2:-127.0.0.1}"
API="${KARAOKE_API:-127.0.0.1:8090}"

exec python3 - "$PORT" "$HOST" "$API" <<'PY'
import sys, socket, http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.musicxml': 'application/vnd.recordare.musicxml+xml',
                      '.mxl': 'application/vnd.recordare.musicxml',
                      '.mscz': 'application/octet-stream',
                      '.webmanifest': 'application/manifest+json'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/api/'):
            return self.relay()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/'):
            return self.relay()
        self.send_error(405)

    def relay(self):
        """Hand /api/* to the API server, if one is listening."""
        try:
            length = int(self.headers.get('content-length') or 0)
            payload = self.rfile.read(length) if length else None
            headers = {'accept': self.headers.get('accept', '*/*')}
            for name in ('content-type', 'x-audio-name'):
                if self.headers.get(name):
                    headers[name] = self.headers[name]
            # Separation holds the line for as long as the model takes.
            conn = http.client.HTTPConnection(api_host, api_port,
                                              timeout=1800 if payload else 30)
            conn.request(self.command, self.path, body=payload, headers=headers)
            upstream = conn.getresponse()
            body = upstream.read()
        except OSError:
            body = b'{"error":"no API server; start server/karaoke.mjs to search your own scores"}'
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return self.wfile.write(body)

        self.send_response(upstream.status)
        for name, value in upstream.getheaders():
            if name.lower() not in ('transfer-encoding', 'connection', 'content-length'):
                self.send_header(name, value)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

port, host = int(sys.argv[1]), sys.argv[2]
api_host, _, api_port = sys.argv[3].partition(':')
api_port = int(api_port or 8090)
shown = 'localhost' if host in ('127.0.0.1', '0.0.0.0') else host
print(f'karaoke → http://{shown}:{port}')
if host == '0.0.0.0':
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('192.0.2.1', 1))          # no packets sent; just picks the route
        print(f'   on your network → http://{s.getsockname()[0]}:{port}')
        s.close()
    except OSError:
        pass
ThreadingHTTPServer((host, port), Handler).serve_forever()
PY
