"""Local stand-in for GitHub Pages plus the GitHub API, for testing MinReader.

  python "Tests/Test Server.py" SITE_FOLDER [PORT]

Serves:
  /MinReader/...   the site (SITE_FOLDER holds the page files and data/)
  /feeds/...       the fake feeds (SITE_FOLDER/_feeds)
  /api/repos/me/MinReader/contents/...   GitHub's contents API (kept in memory)
  /api/repos/me/MinReader/actions/workflows/.../dispatches
  /_test/...       controls used by the tests (see do_test below)

The only accepted access key is "good-key".
"""

import base64
import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(HERE)
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
API_PREFIX = "/api/repos/me/MinReader/"
TOKEN = "good-key"

lock = threading.Lock()
files = {}         # path -> text
fail_next = []     # statuses the next PUTs answer with
log = []           # every API write, for the tests to inspect
dispatches = []
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
         ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".xml": "application/xml"}


def sha_of(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def reset():
    files.clear()
    fail_next.clear()
    log.clear()
    dispatches.clear()
    with open(os.path.join(SITE, "Feeds.json"), encoding="utf-8") as handle:
        files["Feeds.json"] = handle.read()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body=b"", ctype="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    # ---- static files ----
    def static(self, path):
        if path.startswith("/MinReader/"):
            rel, root = path[len("/MinReader/"):] or "index.html", SITE
        elif path.startswith("/feeds/"):
            rel, root = path[len("/feeds/"):], os.path.join(SITE, "_feeds")
        else:
            return self.send(404, "Not found", "text/plain")
        full = os.path.abspath(os.path.join(root, unquote(rel)))
        if not full.startswith(root) or not os.path.isfile(full):
            return self.send(404, "Not found", "text/plain")
        with open(full, "rb") as handle:
            data = handle.read()
        self.send(200, data, TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))

    # ---- fake GitHub API ----
    def api(self, method):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self.send(401, {"message": "Bad credentials"})
        rest = unquote(urlparse(self.path).path[len(API_PREFIX):])
        if rest.startswith("actions/workflows/") and method == "POST":
            dispatches.append(rest)
            return self.send(204)
        if not rest.startswith("contents/"):
            return self.send(404, {"message": "Not Found"})
        path = rest[len("contents/"):]
        with lock:
            if method == "GET":
                if path not in files:
                    return self.send(404, {"message": "Not Found"})
                text = files[path]
                if "raw" in (self.headers.get("Accept") or ""):
                    return self.send(200, text, "text/plain; charset=utf-8")
                big = len(text.encode()) > 1_000_000  # GitHub leaves out the text of files over 1 MB
                return self.send(200, {
                    "sha": sha_of(text), "size": len(text.encode()),
                    "encoding": "none" if big else "base64",
                    "content": "" if big else base64.encodebytes(text.encode()).decode(),
                })
            data = self.body()
            if method == "PUT" and fail_next:
                status = fail_next.pop(0)
                return self.send(status, {"message": f"Test failure {status}"})
            if method == "PUT":
                if path in files and data.get("sha") != sha_of(files[path]):
                    return self.send(409 if data.get("sha") else 422, {"message": "sha mismatch"})
                files[path] = base64.b64decode(data["content"]).decode("utf-8")
                log.append({"op": "put", "path": path, "message": data.get("message")})
                return self.send(201, {"content": {"sha": sha_of(files[path])}})
            if method == "DELETE":
                if path not in files:
                    return self.send(404, {"message": "Not Found"})
                if data.get("sha") != sha_of(files[path]):
                    return self.send(409, {"message": "sha mismatch"})
                del files[path]
                log.append({"op": "delete", "path": path})
                return self.send(200, {})
        return self.send(405, {"message": "Method not allowed"})

    # ---- test controls ----
    def do_test(self, method):
        what = urlparse(self.path).path[len("/_test/"):]
        with lock:
            if what == "reset":
                reset()
                return self.send(200, {})
            if what == "files":
                return self.send(200, files)
            if what == "log":
                return self.send(200, {"log": log, "dispatches": dispatches})
            if what == "set" and method == "POST":  # another device writes a file
                data = self.body()
                if data.get("text") is None:
                    files.pop(data["path"], None)
                else:
                    files[data["path"]] = data["text"]
                return self.send(200, {})
            if what == "fail" and method == "POST":  # the next PUTs answer with these statuses
                fail_next.extend(self.body()["statuses"])
                return self.send(200, {})
        return self.send(404, {})

    def route(self, method):
        path = urlparse(self.path).path
        if path.startswith(API_PREFIX):
            return self.api(method)
        if path.startswith("/_test/"):
            return self.do_test(method)
        if method == "GET":
            return self.static(path)
        return self.send(405, "", "text/plain")

    def do_GET(self):
        self.route("GET")

    def do_PUT(self):
        self.route("PUT")

    def do_POST(self):
        self.route("POST")

    def do_DELETE(self):
        self.route("DELETE")


if __name__ == "__main__":
    reset()
    print(f"Serving {SITE} at http://localhost:{PORT}/MinReader/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
