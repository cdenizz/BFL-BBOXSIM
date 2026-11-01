"""Local-only web server and Blackbox decode bridge; stdlib only."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import threading
import webbrowser
from urllib.parse import urlsplit, unquote
from blackbox_convert import convert_bytes, ConvertError, MAX_FILE_BYTES, locate_decoder

HERE = Path(__file__).resolve().parent
os.chdir(HERE)

class Handler(SimpleHTTPRequestHandler):
    def respond(self, status, data):
        raw = json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        # Same-origin only: do not emit a wildcard CORS header.
        self.end_headers()
        self.wfile.write(raw)

    def end_headers(self):
        # Old versions shared localhost:8765 and browsers cached app.js.
        # Disabling cache prevents stale v0.5 scripts from being displayed as v0.8.1.
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def do_GET(self):
        if urlsplit(self.path).path == '/api/status':
            return self.respond(200, {'decoderAvailable': bool(locate_decoder()), 'builtinGpsAvailable': True, 'version':'0.8.1'})
        return super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != '/api/import-blackbox':
            return self.respond(404, {'error': 'Bilinmeyen işlem.'})
        allowed = ('127.0.0.1', 'localhost')
        if self.headers.get('Host','').split(':')[0] not in allowed:
            return self.respond(403, {'error': 'Yalnızca yerel kullanım.'})
        origin = self.headers.get('Origin', '')
        if origin and origin not in (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'):
            return self.respond(403, {'error': 'Geçersiz istek kaynağı.'})
        try:
            size = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            size = -1
        if size <= 0 or size > MAX_FILE_BYTES:
            return self.respond(413, {'error': 'Dosya boyutu geçersiz veya 150 MB üzerinde.'})
        blob = self.rfile.read(size)
        name = unquote(self.headers.get('X-Flight-Filename', 'flight.bfl')[:180])
        try:
            result = convert_bytes(blob, name)
        except ConvertError as ex:
            return self.respond(422, {'error': str(ex)})
        except Exception as ex:
            print('Blackbox import error:', ex)
            return self.respond(500, {'error': 'Beklenmeyen dönüştürme hatası. Terminali kontrol et.'})
        return self.respond(200, result)

if __name__ == '__main__':
    httpd = None
    for port in (8765, 8766, 8767, 8768):
        try:
            httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit('8765-8768 bağlantı noktaları kullanımda. Eski sunucu pencerelerini kapat.')
    address = f'http://127.0.0.1:{port}'
    print('\nFPV Airspace Control v0.8.1 — '+address)
    print('Decoder:', 'Harici + dahili' if locate_decoder() else 'Dahili')
    print('Durdurmak için Ctrl+C.\n')
    threading.Timer(0.7, lambda: webbrowser.open(address)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
