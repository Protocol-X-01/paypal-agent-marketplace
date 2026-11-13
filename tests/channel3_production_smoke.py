#!/usr/bin/env python3
"""Exercise a built Next service against a synthetic loopback TLS provider."""
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True
import market_currency_simulation as isolation

ROOT = Path(__file__).resolve().parents[1]


def offer(domain="bestbuy.com", availability="InStock", url=None):
    return {"domain": domain, "url": url or f"https://{domain}/item", "availability": availability,
            "condition": "new", "price": {"price": 120, "currency": "USD"}}


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("x-api-key") != "simulation-only":
            self.respond(401, {"error": "unexpected synthetic credential"})
            return
        parsed = urllib.parse.urlsplit(self.path)
        self.server.calls.append(("GET", parsed.path, urllib.parse.parse_qs(parsed.query)))
        product_id = parsed.path.rsplit("/", 1)[-1]
        if product_id == "missing-product":
            self.respond(404, {"error": "synthetic missing product"})
        elif product_id == "foreign-product":
            self.respond(200, {"id": product_id, "title": "Foreign offer", "offers": [offer("shop.co.uk")]})
        elif product_id == "soldout-product":
            self.respond(200, {"id": product_id, "title": "Sold-out item", "offers": [offer(availability="OutOfStock")]})
        else:
            self.respond(404, {"error": "unmodeled product"})

    def do_POST(self):
        if self.headers.get("x-api-key") != "simulation-only":
            self.respond(401, {"error": "unexpected synthetic credential"})
            return
        payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        self.server.calls.append(("POST", self.path, payload))
        if self.path == "/v1/search":
            second = payload.get("page_token") == "provider-page-two"
            item = {"id": "headphones-2" if second else "headphones-1", "title": "Synthetic headphones",
                    "offers": [offer(), offer("walmart.com"), offer(url="https://other.example/item")]}
            self.respond(200, {"products": [item], "next_page_token": None if second else "provider-page-two"})
        elif self.path == "/v1/similar":
            self.respond(200, {"products": [
                {"id": "missing-product", "title": "Source", "offers": [offer()]},
                {"id": "alternative-1", "title": "Alternative", "offers": [offer(), offer(availability="OutOfStock")]},
                {"id": "alternative-2", "title": "Unsafe", "offers": [offer(url="https://other.example/item")]},
            ]})
        else:
            self.respond(404, {"error": "unmodeled endpoint"})


def request(base, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response), response.headers


def main():
    isolation.__file__ = str(Path(__file__).resolve())
    isolation.enter_private_namespaces()
    if not (ROOT / ".next/BUILD_ID").is_file():
        raise RuntimeError("Build the candidate before the production smoke check")
    if not all(shutil.which(command) for command in ("node", "openssl")):
        raise RuntimeError("Node and OpenSSL are required")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="paypal-channel3-production-", dir=ROOT.parent) as temporary:
        work = Path(temporary)
        key, cert = work / "key.pem", work / "cert.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                        "-keyout", str(key), "-out", str(cert), "-nodes", "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=IP:127.0.0.1"], check=True, capture_output=True, timeout=15)
        mock = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        mock.calls = []
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        mock.socket = tls.wrap_socket(mock.socket, server_side=True)
        thread = threading.Thread(target=mock.serve_forever, daemon=True)
        thread.start()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "NODE_ENV": "production",
               "NEXT_TELEMETRY_DISABLED": "1", "NODE_EXTRA_CA_CERTS": str(cert),
               "CHANNEL3_API_KEY": "simulation-only", "CHANNEL3_BASE_URL": f"https://127.0.0.1:{mock.server_port}",
               "CHANNEL3_COLLECTION_ID": "fixture-collection", "CHANNEL3_COUNTRY": "US", "CHANNEL3_CURRENCY": "USD",
               "CHANNEL3_LANGUAGE": "en"}
        log = work / "next.log"
        process = None
        try:
            with log.open("w") as output:
                process = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", str(port)],
                                           cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Production server exited before readiness")
                try:
                    status, _, _ = request(base, "/api/health")
                    if status == 200:
                        break
                except (OSError, ValueError):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("Production server did not become ready")
                time.sleep(.2)

            brief = "Please help me find headphones from Best Buy under $150"
            query = {"query": brief, "mode": "agentic", "storefront": "US", "limit": 6}
            status, first, headers = request(base, "/api/marketplace/search", query)
            assert status == 200 and first["searchMode"] == "agentic" and first["priceRange"] == {"maxPrice": 150}
            assert [item["domain"] for item in first["products"][0]["offers"]] == ["bestbuy.com"]
            assert headers.get("Cache-Control") == "no-store" and first["nextPageToken"]
            token = first["nextPageToken"]
            status, second, _ = request(base, "/api/marketplace/search", {**query, "pageToken": token})
            assert status == 200 and second["searchMode"] == "agentic" and second["products"][0]["id"] == "headphones-2"
            status, _, _ = request(base, "/api/marketplace/search", {**query, "mode": "default", "pageToken": token})
            assert status == 400
            legacy = {key: value for key, value in query.items() if key != "mode"}
            status, legacy_result, _ = request(base, "/api/marketplace/search", {**legacy, "unknownOption": "local-only-fixture"})
            assert status == 200 and "searchMode" not in legacy_result
            searches = [item[2] for item in mock.calls if item[:2] == ("POST", "/v1/search")]
            assert len(searches) == 3 and all(item["query"] == brief and item["config"]["mode"] == "agentic" for item in searches[:2])
            assert all(item["filters"]["price"] == {"max_price": 150} and item["filters"]["website_ids"] == ["p1PB"] for item in searches)
            assert searches[1]["page_token"] == "provider-page-two"
            assert searches[2]["config"]["mode"] == "default" and "local-only-fixture" not in json.dumps(searches[2])
            print("PASS production assisted search, bound continuation, and legacy response compatibility", flush=True)

            for product_id in ("missing-product", "foreign-product"):
                status, body, _ = request(base, f"/api/marketplace/products/{product_id}?storefront=US")
                assert status == 404 and body.get("code") == "PRODUCT_UNAVAILABLE"
            status, soldout, _ = request(base, "/api/marketplace/products/soldout-product?storefront=US")
            assert status == 200 and soldout["product"]["offers"][0]["availability"] == "OutOfStock"
            status, similar, _ = request(base, "/api/marketplace/products/missing-product/similar?storefront=US")
            assert status == 200 and [item["id"] for item in similar["products"]] == ["alternative-1"]
            assert len(similar["products"][0]["offers"]) == 1
            print("PASS production product-unavailable and in-stock alternative routes", flush=True)
        except Exception:
            if log.exists():
                print(log.read_text(errors="replace")[-4000:], file=sys.stderr, flush=True)
            raise
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            mock.shutdown()
            mock.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    main()
