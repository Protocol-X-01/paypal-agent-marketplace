#!/usr/bin/env python3
"""Exercise a built Next service against a synthetic loopback TLS provider."""
import json
import os
from contextlib import ExitStack
from pathlib import Path
import shutil
import signal
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
PG_BIN = Path("/usr/lib/postgresql/18/bin")
FIXTURE_USER = "paypal_channel3_budget_runtime"
FIXTURE_PASSWORD = "fictional-local-test-only"


def enter_fixture_namespaces():
    """Keep all TCP local while allowing PostgreSQL to run as non-root."""
    if len(sys.argv) == 1:
        for command in ("unshare", "mount", "umount", "ip", "newuidmap", "newgidmap", "setpriv"):
            if shutil.which(command) is None:
                raise RuntimeError(f"{command} is required for the isolated fixture")
        clean_env = {key: os.environ[key] for key in ("HOME", "PATH") if key in os.environ}
        clean_env[isolation.PARENT_MOUNT_NS] = str(os.stat("/proc/self/ns/mnt").st_ino)
        clean_env[isolation.PARENT_NETWORK_NS] = str(os.stat("/proc/self/ns/net").st_ino)
        os.execvpe("unshare", ["unshare", "-Urnm", "--map-auto", sys.executable, __file__, isolation.ISOLATED_ARGUMENT], clean_env)
    isolation.__file__ = str(Path(__file__).resolve())
    isolation.enter_private_namespaces()


def stop_process(process):
    if process is None or getattr(process, "fixture_stopped", False):
        return
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    deadline = time.monotonic() + 5
    while True:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        if time.monotonic() >= deadline:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise RuntimeError("A fixture child process remained after shutdown")
        time.sleep(.05)
    process.fixture_stopped = True


def stop_provider(mock, thread):
    mock.shutdown()
    mock.server_close()
    thread.join(timeout=5)
    if thread.is_alive():
        raise RuntimeError("The synthetic provider did not stop")


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def pg_command(*args):
    # UID/GID 1 are mapped subordinate IDs within this private user namespace.
    return ["setpriv", "--reuid=1", "--regid=1", "--clear-groups", *map(str, args)]


def run_sql(socket_path, port, sql, user="budget_fixture"):
    command = pg_command(PG_BIN / "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                         "-h", socket_path, "-p", port, "-U", user, "postgres")
    result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=15, cwd=socket_path.parent,
                            env={"PATH": "/usr/bin:/bin", "LANG": "C", "TZ": "UTC"})
    if result.returncode:
        raise RuntimeError(f"Synthetic PostgreSQL operation failed: {result.stderr[-1000:]}")
    return result.stdout.strip()


def budget_counters(socket_path, port):
    rows = run_sql(socket_path, port,
        "SELECT period || ':' || used FROM paypal_markets_channel3_budget.counters ORDER BY period;")
    return dict(row.split(":", 1) for row in rows.splitlines())


def start_fixture_postgres(work, key, cert, resources):
    pg_dir, socket_path = work / "pg", work / "pg" / "socket"
    pg_dir.mkdir(mode=0o700)
    socket_path.mkdir(mode=0o700)
    for path in (pg_dir, socket_path):
        os.chown(path, 1, 1)
    pg_cert, pg_key = pg_dir / "server.crt", pg_dir / "server.key"
    shutil.copyfile(cert, pg_cert)
    shutil.copyfile(key, pg_key)
    os.chmod(pg_key, 0o600)
    os.chown(pg_cert, 1, 1)
    os.chown(pg_key, 1, 1)
    data = pg_dir / "data"
    clean_env = {"PATH": "/usr/bin:/bin", "LANG": "C", "TZ": "UTC", "HOME": str(pg_dir)}
    subprocess.run(pg_command(PG_BIN / "initdb", "-D", data, "--auth-local=trust",
                              "--auth-host=scram-sha-256", "--no-sync", "--username=budget_fixture"),
                   check=True, capture_output=True, timeout=20, cwd=pg_dir, env=clean_env)
    port = unused_port()
    log = (work / "postgres.log").open("w")
    resources.callback(log.close)
    process = subprocess.Popen(pg_command(PG_BIN / "postgres", "-D", data, "-k", socket_path, "-p", port,
        "-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_permissions=0700", "-c", "ssl=on",
        "-c", f"ssl_cert_file={pg_cert}", "-c", f"ssl_key_file={pg_key}", "-c", "shared_buffers=12MB",
        "-c", "max_connections=10", "-c", "max_worker_processes=0", "-c", "max_parallel_workers=0",
        "-c", "max_wal_senders=0", "-c", "autovacuum=off"), cwd=pg_dir, env=clean_env,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    resources.callback(stop_process, process)
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError("Synthetic PostgreSQL exited before readiness")
        try:
            if run_sql(socket_path, port, "SELECT 1;") == "1":
                break
        except RuntimeError:
            time.sleep(.1)
    else:
        raise RuntimeError("Synthetic PostgreSQL did not become ready")
    run_sql(socket_path, port, "CREATE ROLE paypal_budget_migrator LOGIN CREATEROLE;"
            " ALTER DATABASE postgres OWNER TO paypal_budget_migrator;"
            " REVOKE ALL PRIVILEGES ON DATABASE postgres FROM PUBLIC;")
    migration = (ROOT / "docs/channel3-request-budget-migration.sql").read_text()
    run_sql(socket_path, port, migration, user="paypal_budget_migrator")
    run_sql(socket_path, port, f"ALTER ROLE {FIXTURE_USER} LOGIN PASSWORD '{FIXTURE_PASSWORD}';")
    # This second fictional role models the wider auth role; it is not the
    # separate reviewed atomic installer or an isolation claim.
    run_sql(socket_path, port, f"CREATE ROLE paypal_auth_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
        f"NOINHERIT PASSWORD '{FIXTURE_PASSWORD}'; GRANT CONNECT ON DATABASE postgres TO paypal_auth_runtime; "
        "CREATE SCHEMA fictional_auth; CREATE TABLE fictional_auth.sessions (value text); "
        "INSERT INTO fictional_auth.sessions VALUES ('fictional'); "
        "REVOKE ALL ON SCHEMA fictional_auth FROM PUBLIC; "
        "GRANT USAGE ON SCHEMA fictional_auth TO paypal_auth_runtime; "
        "GRANT SELECT, UPDATE ON fictional_auth.sessions TO paypal_auth_runtime; "
        "GRANT USAGE ON SCHEMA paypal_markets_channel3_budget TO paypal_auth_runtime; "
        "GRANT EXECUTE ON FUNCTION paypal_markets_channel3_budget.reserve_request() TO paypal_auth_runtime;")
    return process, socket_path, port


def offer(domain="bestbuy.com", availability="InStock", url=None):
    return {"domain": domain, "url": url or f"https://{domain}/item", "availability": availability,
            "condition": "new", "price": {"price": 120, "currency": "USD"}}


class ProviderServer(ThreadingHTTPServer):
    def __init__(self, address, handler):
        super().__init__(address, handler)
        self.connections = 0
        self.arrivals = []
        self.calls = []
        self.tls_context = None

    def get_request(self):
        # Count before the TLS handshake, including clients whose handshake
        # fails before an HTTP handler can be constructed.
        connection, address = super().get_request()
        self.connections += 1
        try:
            connection.settimeout(5)
            wrapped = self.tls_context.wrap_socket(connection, server_side=True)
            wrapped.settimeout(5)
            return wrapped, address
        except Exception:
            connection.close()
            raise


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def record_arrival(self, method):
        if not getattr(self, "arrival_recorded", False):
            self.server.arrivals.append((method, self.path))
            self.arrival_recorded = True

    def parse_request(self):
        parsed = super().parse_request()
        if parsed:
            # Count even unsupported methods. Reset for each request if a
            # connection happens to carry more than one HTTP request.
            self.arrival_recorded = False
            self.record_arrival(self.command)
        return parsed

    def respond(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.record_arrival("GET")
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
        self.record_arrival("POST")
        if self.headers.get("x-api-key") != "simulation-only":
            self.respond(401, {"error": "unexpected synthetic credential"})
            return
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except (ValueError, TypeError):
            self.respond(400, {"error": "invalid synthetic request"})
            return
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


def provider_state(mock):
    return (mock.connections, len(mock.arrivals), len(mock.calls))


def verify_provider_recorder(mock, cert):
    """Exercise rejected credentials, malformed JSON and a failed TLS handshake."""
    before = provider_state(mock)
    context = ssl.create_default_context(cafile=str(cert))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
    for body, key, method, expected in ((b'{}', 'fictional-wrong-key', 'POST', 401),
                                        (b'{', 'simulation-only', 'POST', 400),
                                        (b'{}', 'simulation-only', 'PUT', 501)):
        req = urllib.request.Request(f"https://127.0.0.1:{mock.server_port}/v1/search", data=body,
                                     headers={"x-api-key": key, "Content-Type": "application/json"}, method=method)
        try:
            opener.open(req, timeout=5)
            raise AssertionError("synthetic rejected request unexpectedly succeeded")
        except urllib.error.HTTPError as error:
            with error:
                assert error.code == expected
    with socket.create_connection(("127.0.0.1", mock.server_port), timeout=5) as connection:
        connection.sendall(b"not a TLS handshake")
    deadline = time.monotonic() + 3
    while mock.connections < before[0] + 4 and time.monotonic() < deadline:
        time.sleep(.01)
    assert provider_state(mock) == (before[0] + 4, before[1] + 3, before[2])


def request(base, path, payload=None, client="192.0.2.12"):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"cf-connecting-ip": client}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response), response.headers


def start_next(env, work, resources, name):
    port = unused_port()
    base = f"http://127.0.0.1:{port}"
    with (work / f"{name}.log").open("w") as output:
        process = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", str(port)],
                                   cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    resources.callback(stop_process, process)
    deadline = time.monotonic() + 30
    while True:
        if process.poll() is not None:
            raise RuntimeError(f"Production server exited during {name}")
        try:
            if request(base, "/api/health")[0] == 200:
                break
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Production server was not ready during {name}")
        time.sleep(.2)
    return process, base


def expect_budget_failure(env, work, resources, query, mock, pg_socket, pg_port, name):
    """A fresh process proves its own production configuration fails closed."""
    before_provider = provider_state(mock)
    before_counters = budget_counters(pg_socket, pg_port)
    process, base = start_next(env, work, resources, name)
    status, _, headers = request(base, "/api/marketplace/search", query, client="192.0.2.14")
    assert status == 503 and headers.get("Cache-Control") == "no-store"
    time.sleep(.1)
    assert provider_state(mock) == before_provider and budget_counters(pg_socket, pg_port) == before_counters
    stop_process(process)


def expect_auth_alias_success(env, work, resources, query, mock, pg_socket, pg_port):
    privileges = run_sql(pg_socket, pg_port, "SELECT "
        "has_table_privilege('paypal_auth_runtime','fictional_auth.sessions','SELECT') || '|' || "
        "has_table_privilege('paypal_auth_runtime','paypal_markets_channel3_budget.counters','SELECT');")
    assert privileges == "true|false", "fixture auth role is broad but cannot directly read budget counters"
    alias_url = f"postgresql://paypal_auth_runtime:{FIXTURE_PASSWORD}@127.0.0.1:{pg_port}/postgres"
    alias_env = dict(env)
    alias_env["AUTH_SESSION_DATABASE_URL"] = alias_url
    alias_env["CHANNEL3_BUDGET_DATABASE_URL"] = alias_url
    before_provider = provider_state(mock)
    before = budget_counters(pg_socket, pg_port)
    process, base = start_next(alias_env, work, resources, "auth-role-alias")
    status, body, _ = request(base, "/api/marketplace/search", query, client="192.0.2.15")
    assert status == 200 and body.get("provider") == "Channel3"
    after = budget_counters(pg_socket, pg_port)
    after_provider = provider_state(mock)
    assert after_provider[1:] == (before_provider[1] + 1, before_provider[2] + 1)
    assert after_provider[0] >= before_provider[0] and int(after["day"]) == int(before["day"]) + 1
    stop_process(process)


def main():
    enter_fixture_namespaces()
    if not (ROOT / ".next/BUILD_ID").is_file():
        raise RuntimeError("Build the candidate before the production smoke check")
    if not all(shutil.which(command) for command in ("node", "openssl")) or not all(
        (PG_BIN / command).is_file() for command in ("initdb", "postgres", "psql")
    ):
        raise RuntimeError("Node, OpenSSL, and PostgreSQL 18 are required")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="paypal-channel3-production-", dir="/dev/shm") as temporary, ExitStack() as resources:
        work = Path(temporary)
        # The non-root mapped PostgreSQL UID needs path traversal, while fixture
        # files themselves remain owner-only unless explicitly shared.
        os.chmod(work, 0o711)
        key, cert = work / "key.pem", work / "cert.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                        "-keyout", str(key), "-out", str(cert), "-nodes", "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=IP:127.0.0.1"], check=True, capture_output=True, timeout=15)
        pg_process, pg_socket, pg_port = start_fixture_postgres(work, key, cert, resources)
        mock = ProviderServer(("127.0.0.1", 0), Provider)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        mock.tls_context = tls
        thread = threading.Thread(target=mock.serve_forever, daemon=True)
        thread.start()
        resources.callback(stop_provider, mock, thread)
        verify_provider_recorder(mock, cert)
        print("PASS provider recorder detects bad credentials, malformed JSON, unsupported methods and failed TLS handshakes", flush=True)
        port = unused_port()
        base = f"http://127.0.0.1:{port}"
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "NODE_ENV": "production",
               "NEXT_TELEMETRY_DISABLED": "1", "NODE_EXTRA_CA_CERTS": str(cert),
               "CHANNEL3_API_KEY": "simulation-only", "CHANNEL3_BASE_URL": f"https://127.0.0.1:{mock.server_port}",
               "CHANNEL3_COLLECTION_ID": "fixture-collection", "CHANNEL3_COUNTRY": "US", "CHANNEL3_CURRENCY": "USD",
               "CHANNEL3_LANGUAGE": "en", "CHANNEL3_BUDGET_DATABASE_URL":
               f"postgresql://{FIXTURE_USER}:{FIXTURE_PASSWORD}@127.0.0.1:{pg_port}/postgres"}
        log = work / "next.log"
        process = None
        try:
            with log.open("w") as output:
                process = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", str(port)],
                                           cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            resources.callback(stop_process, process)
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
            missing_url_env = dict(env)
            del missing_url_env["CHANNEL3_BUDGET_DATABASE_URL"]
            expect_budget_failure(missing_url_env, work, resources, query, mock, pg_socket, pg_port, "missing-budget-url")
            print("PASS missing production budget URL fails closed before reaching the synthetic provider", flush=True)
            before_provider = provider_state(mock)
            status, _, _ = request(base, "/api/marketplace/search", query, client="192.0.2.11")
            time.sleep(.1)
            assert status == 503 and provider_state(mock) == before_provider, "unconfigured limits must not reach the synthetic provider"
            assert budget_counters(pg_socket, pg_port) == {"day": "0", "minute": "0", "second": "0"}
            print("PASS unconfigured production budget fails closed before reaching the synthetic provider", flush=True)

            # A fixture-only day limit of one deterministically exercises denial
            # without waiting for 100 calls or racing a second-window boundary.
            day_remaining = 86_400 - (time.time() % 86_400)
            if day_remaining < 45:
                time.sleep(day_remaining + .1)
            run_sql(pg_socket, pg_port, "UPDATE paypal_markets_channel3_budget.limits SET request_limit = CASE period "
                    "WHEN 'second' THEN 2 WHEN 'minute' THEN 30 WHEN 'day' THEN 1 END;")
            status, first, headers = request(base, "/api/marketplace/search", query, client="192.0.2.11")
            assert status == 200 and first["searchMode"] == "agentic" and first["priceRange"] == {"maxPrice": 150}
            assert [item["domain"] for item in first["products"][0]["offers"]] == ["bestbuy.com"]
            assert headers.get("Cache-Control") == "no-store" and first["nextPageToken"]
            assert len(mock.calls) == 1 and len(mock.arrivals) == before_provider[1] + 1
            assert budget_counters(pg_socket, pg_port) == {"day": "1", "minute": "1", "second": "1"}
            encrypted = run_sql(pg_socket, pg_port, "SELECT count(*) FROM pg_stat_ssl s "
                "JOIN pg_stat_activity a ON a.pid=s.pid WHERE s.ssl AND a.usename='paypal_channel3_budget_runtime';")
            assert int(encrypted) >= 1, "the runtime connection must use TLS"
            before = budget_counters(pg_socket, pg_port)
            before_provider = provider_state(mock)
            status, denied, headers = request(base, "/api/marketplace/search", query, client="192.0.2.11")
            assert status == 429 and "shared product-search budget" in denied.get("error", "")
            assert headers.get("Cache-Control") == "no-store" and 1 <= int(headers["Retry-After"]) <= 86_400
            time.sleep(.1)
            assert provider_state(mock) == before_provider and budget_counters(pg_socket, pg_port) == before, "denial cannot reach the synthetic provider or consume quota"
            print("PASS TLS-backed reservation, provider success, and non-consuming quota denial", flush=True)
            run_sql(pg_socket, pg_port, "UPDATE paypal_markets_channel3_budget.limits SET request_limit=100 WHERE period='day';")
            token = first["nextPageToken"]
            time.sleep(1.05)
            status, second, _ = request(base, "/api/marketplace/search", {**query, "pageToken": token})
            assert status == 200 and second["searchMode"] == "agentic" and second["products"][0]["id"] == "headphones-2"
            status, _, _ = request(base, "/api/marketplace/search", {**query, "mode": "default", "pageToken": token})
            assert status == 400
            legacy = {key: value for key, value in query.items() if key != "mode"}
            time.sleep(1.05)
            status, legacy_result, _ = request(base, "/api/marketplace/search", {**legacy, "unknownOption": "local-only-fixture"})
            assert status == 200 and "searchMode" not in legacy_result
            searches = [item[2] for item in mock.calls if item[:2] == ("POST", "/v1/search")]
            assert len(searches) == 3 and all(item["query"] == brief and item["config"]["mode"] == "agentic" for item in searches[:2])
            assert all(item["filters"]["price"] == {"max_price": 150} and item["filters"]["website_ids"] == ["p1PB"] for item in searches)
            assert searches[1]["page_token"] == "provider-page-two"
            assert searches[2]["config"]["mode"] == "default" and "local-only-fixture" not in json.dumps(searches[2])
            print("PASS production assisted search, bound continuation, and legacy response compatibility", flush=True)

            for product_id in ("missing-product", "foreign-product"):
                time.sleep(1.05)
                status, body, _ = request(base, f"/api/marketplace/products/{product_id}?storefront=US")
                assert status == 404 and body.get("code") == "PRODUCT_UNAVAILABLE"
            time.sleep(1.05)
            status, soldout, _ = request(base, "/api/marketplace/products/soldout-product?storefront=US")
            assert status == 200 and soldout["product"]["offers"][0]["availability"] == "OutOfStock"
            time.sleep(1.05)
            status, similar, _ = request(base, "/api/marketplace/products/missing-product/similar?storefront=US")
            assert status == 200 and [item["id"] for item in similar["products"]] == ["alternative-1"]
            assert len(similar["products"][0]["offers"]) == 1
            assert similar["products"][0]["offers"][0]["availability"] == "InStock"
            assert similar["products"][0]["offers"][0]["url"] == "https://bestbuy.com/item"
            print("PASS production product-unavailable and in-stock alternative routes", flush=True)
            time.sleep(1.05)
            expect_auth_alias_success(env, work, resources, query, mock, pg_socket, pg_port)
            print("PASS fictional broader auth-role URL alias reserves and reaches the synthetic provider", flush=True)
            untrusted_env = dict(env)
            del untrusted_env["NODE_EXTRA_CA_CERTS"]
            expect_budget_failure(untrusted_env, work, resources, query, mock, pg_socket, pg_port, "untrusted-budget-certificate")
            print("PASS untrusted database certificate fails closed before reaching the synthetic provider", flush=True)
            before_provider = provider_state(mock)
            stop_process(pg_process)
            status, _, _ = request(base, "/api/marketplace/search", query, client="192.0.2.13")
            time.sleep(.1)
            assert status == 503 and provider_state(mock) == before_provider, "lost database must not reach the synthetic provider"
            print("PASS unavailable PostgreSQL fails closed before reaching the synthetic provider", flush=True)
        except Exception:
            if log.exists():
                print(log.read_text(errors="replace")[-4000:], file=sys.stderr, flush=True)
            raise

    assert not work.exists(), "the temporary fixture directory must be removed after normal completion"
    print("PASS fixture processes stopped and temporary data removed after normal completion", flush=True)


if __name__ == "__main__":
    main()
