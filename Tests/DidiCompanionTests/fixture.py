"""Disposable HTTP protocol/security fixture; not production integration evidence."""
import http.server
import json
import os
import secrets
import sys
import threading
import uuid

credential = secrets.token_urlsafe(32)
page_cookie = secrets.token_urlsafe(32)
csrf = secrets.token_urlsafe(32)
code = secrets.token_urlsafe(32)
epoch = str(uuid.uuid4())
session = str(uuid.uuid4())
replays = {}
counts = {"entries": 0, "frames": 0, "root": 0}
mode = "normal"
active = False
code_valid = False

class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # No credentials, private text, or cookie logs.

    def reply(self, data, status=200, headers=None):
        encoded = json.dumps({"data": data, "requestId": str(uuid.uuid4()), "authorityEpoch": epoch}).encode()
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def native(self):
        return self.headers.get("Authorization") == "Bearer " + credential

    def paired(self):
        return active and self.headers.get("Cookie") == "didi_session=" + page_cookie

    def do_GET(self):
        global mode, active
        if self.path.startswith("/fixture/mode/"):
            mode = self.path.rsplit("/", 1)[1]
            self.reply({})
            return
        if self.path == "/fixture/expire":
            active = False
            self.reply({})
            return
        if self.path == "/":
            counts["root"] += 1
            if mode == "stall":
                mode = "normal"
                threading.Event().wait(6)  # real unanswered HTTP; bounded, no CPU load
                self.close_connection = True
                return
            if mode == "redirect":
                mode = "normal"
                self.send_response(302)
                self.send_header("Location", origin + "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if mode == "download":
                mode = "normal"
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", "attachment; filename=refused.bin")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if not self.paired():
                self.reply({}, 401)
                return
            html = b'<!doctype html><html><head><title>Didi shared fixture UI</title></head><body data-authenticated="yes" style="background:#101321;color:#ebefff;font:22px system-ui;padding:48px"><h1>Didi shared service UI</h1><p>Protocol fixture, not accepted Naya UI integration.</p><div style="border-radius:50%;width:180px;height:180px;background:radial-gradient(circle at 30% 30%,#adcaff,#555bb5,#181b35)"></div><script>document.body.dataset.instance=crypto.randomUUID()</script></body></html>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(html)))
            self.send_header("Permissions-Policy", "microphone=(), camera=(), geolocation=()")
            self.end_headers()
            self.wfile.write(html)
        elif self.path == "/api/v1/auth/session" and self.paired():
            self.reply({"clientId": str(uuid.uuid4()), "csrfToken": csrf})
        elif self.path == "/api/v1/status" and self.native():
            self.reply({"assistantId": str(uuid.uuid4()), "authorityEpoch": epoch, "capabilities": {"memory": True}})
        elif self.path == "/fixture/counts":
            self.reply(counts)
        elif self.path == "/frame":
            counts["frames"] += 1
            self.reply({})
        else:
            self.reply({}, 404)

    def do_POST(self):
        global code, code_valid, active, page_cookie, csrf
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        if self.path == "/api/v1/auth/pairing" and self.native():
            code = secrets.token_urlsafe(32)
            code_valid = True
            self.reply({"pairingCode": code, "expiresAt": "2099-01-01T00:00:00.000Z"})
        elif self.path == "/api/v1/auth/pair" and code_valid and body == {"pairingCode": code} and self.headers.get("Origin") == origin:
            code_valid = False
            active = True
            page_cookie = secrets.token_urlsafe(32)
            csrf = secrets.token_urlsafe(32)
            self.reply({"csrfToken": csrf}, headers={"Set-Cookie": "didi_session=" + page_cookie + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200"})
        elif self.path == "/api/v1/auth/logout" and self.paired() and self.headers.get("X-Didi-CSRF") == csrf:
            active = False
            self.reply({"ok": True}, headers={"Set-Cookie": "didi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
        elif self.native() and self.headers.get("X-Didi-Authority-Epoch") == epoch and self.path in ("/api/v1/sessions", "/api/v1/sessions/" + session + "/entries"):
            key = self.headers.get("Idempotency-Key")
            if not key:
                self.reply({}, 400)
                return
            fingerprint = (self.path, json.dumps(body, sort_keys=True))
            if key in replays:
                old_fingerprint, result = replays[key]
                self.reply(result, 200 if old_fingerprint == fingerprint else 409)
                return
            if self.path == "/api/v1/sessions":
                if set(body) != {"title", "timeZone"}:
                    self.reply({}, 400)
                    return
                result = {"id": session, "title": body["title"], "timeZone": body["timeZone"], "revision": 1}
            else:
                if set(body) != {"text", "role", "timeZone"} or body["role"] != "user":
                    self.reply({}, 400)
                    return
                counts["entries"] += 1
                result = {"id": str(uuid.uuid4()), "sessionId": session, "sequence": counts["entries"], "role": "user", "text": body["text"]}
            replays[key] = (fingerprint, result)
            if self.path.endswith("/entries"):
                # Persist then drop the first reply: ambiguous real network outcome.
                self.close_connection = True
                return
            self.reply(result)
        else:
            self.reply({}, 401)

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
origin = "http://127.0.0.1:" + str(server.server_port)
path = sys.argv[1]
fd = os.open(path + ".pending", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output:
    json.dump({"port": server.server_port, "credential": credential, "authorityEpoch": epoch}, output)
os.rename(path + ".pending", path)
server.serve_forever()
