#!/usr/bin/env python3
"""Run the market routes against a local, synthetic Postman simulation."""

import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
SIMULATION = Path("postman/simulations/coingecko-currency-regression.sim.yaml")
MOCK = Path("postman/mocks/coingecko-currency-regression")
SOURCE_FILES = (
    "package.json", "next.config.ts", "next-env.d.ts", "tsconfig.json",
    "src/lib/market-assets.ts", "src/lib/market-currency.ts", "src/lib/market-data.ts",
    "src/lib/mobile-web-cors.ts", "src/lib/request-limits.ts", "src/app/api/market/quotes/route.ts",
    "src/app/api/market/coins/route.ts", "src/app/api/market/chart/[coinId]/route.ts",
)
PROVIDER_BASE = 'const COINGECKO_BASE = "https://api.coingecko.com/api/v3";'
ISOLATED_ARGUMENT = "--inside-market-simulation-namespaces"
PARENT_MOUNT_NS = "MARKET_SIMULATION_PARENT_MOUNT_NAMESPACE"
PARENT_NETWORK_NS = "MARKET_SIMULATION_PARENT_NETWORK_NAMESPACE"
GUARD = r"""
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === 'number') options = { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (typeof options === 'string') options = { path: options };
  const host = options?.host || 'localhost';
  if (!options?.path && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('market simulation blocks non-loopback TCP connections');
  }
  return connect.apply(this, args);
};
"""


def enter_private_namespaces():
    if len(sys.argv) == 1:
        for command in ("unshare", "mount", "umount", "ip"):
            if shutil.which(command) is None:
                raise RuntimeError(f"{command} is required for the local-only simulation")
        # Carry the existing home directory through unchanged; keep unrelated
        # environment variables, including credentials, out of child processes.
        clean_env = {key: os.environ[key] for key in ("HOME", "PATH") if key in os.environ}
        clean_env[PARENT_MOUNT_NS] = str(os.stat("/proc/self/ns/mnt").st_ino)
        clean_env[PARENT_NETWORK_NS] = str(os.stat("/proc/self/ns/net").st_ino)
        os.execvpe("unshare", ["unshare", "-Urnm", sys.executable, __file__, ISOLATED_ARGUMENT], clean_env)
    if (sys.argv[1:] != [ISOLATED_ARGUMENT] or not os.environ.get(PARENT_MOUNT_NS)
            or not os.environ.get(PARENT_NETWORK_NS)
            or str(os.stat("/proc/self/ns/mnt").st_ino) == os.environ[PARENT_MOUNT_NS]
            or str(os.stat("/proc/self/ns/net").st_ino) == os.environ[PARENT_NETWORK_NS]):
        raise RuntimeError("Private mount and network namespaces were not established")
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True, capture_output=True)


def events(path):
    if not path.exists():
        return []
    parsed = []
    for line in path.read_text().splitlines():
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # The process may be in the middle of writing a line.
    return parsed


def wait_for(process, predicate, timeout, description):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        if process.poll() is not None:
            raise RuntimeError(f"{description} exited with status {process.returncode}")
        time.sleep(0.2)
    raise RuntimeError(f"Timed out waiting for {description}")


def stop(process):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def request(opener, base, path):
    try:
        response = opener.open(base + path, timeout=45)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response), response.headers


def check_cases(base):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    cases = (
        ("GBP quotes", "/api/market/quotes?currency=GBP"),
        ("GBP chart", "/api/market/chart/bitcoin?days=7&currency=GBP"),
        ("negative price chart", "/api/market/chart/bitcoin?days=7&currency=CAD"),
        ("negative market cap chart", "/api/market/chart/bitcoin?days=7&currency=NZD"),
        ("negative volume chart", "/api/market/chart/bitcoin?days=7&currency=SGD"),
        ("fractional timestamp chart", "/api/market/chart/bitcoin?days=7&currency=NOK"),
        ("empty EUR quotes", "/api/market/quotes?currency=EUR"),
        ("JPY provider failure", "/api/market/quotes?currency=JPY"),
        ("AUD 7-day fallback", "/api/market/chart/bitcoin?days=7&currency=AUD"),
        ("AUD 30-day rate limit", "/api/market/chart/bitcoin?days=30&currency=AUD"),
        ("CHF quote rate limit", "/api/market/quotes?currency=CHF"),
        ("unsupported quote currency", "/api/market/quotes?currency=XYZ"),
        ("unsupported chart currency", "/api/market/chart/bitcoin?days=7&currency=XYZ"),
        ("legacy USD quotes", "/api/market/coins"),
    )
    failures = []
    for name, path in cases:
        try:
            status, body, headers = request(opener, base, path)
            code = body.get("error", {}).get("code")
            if name == "GBP quotes":
                coin = body["coins"][0]
                ok = (status == 200 and body["currency"] == "GBP" and body["provider"] == "CoinGecko"
                      and coin["price"] == 12345.67 and coin["change24hPct"] == 2.5
                      and all(isinstance(coin[field], (int, float)) for field in
                              ("marketCap", "volume24h", "high24h", "low24h"))
                      and all(field not in coin for field in
                              ("priceUsd", "marketCapUsd", "volume24hUsd", "high24hUsd", "low24hUsd")))
            elif name == "GBP chart":
                ok = (status == 200 and body["currency"] == "GBP" and body["coinId"] == "bitcoin"
                      and body["seriesSource"] == "market_chart" and body["prices"] == [
                          {"timestamp": 1730000000000, "value": 12000},
                          {"timestamp": 1730003600000, "value": 12500},
                      ])
            elif name == "empty EUR quotes":
                ok = status == 502 and code == "upstream_invalid_response"
            elif name in {"negative price chart", "negative market cap chart", "negative volume chart", "fractional timestamp chart"}:
                ok = status == 502 and code == "upstream_invalid_response" and "prices" not in body
            elif name == "JPY provider failure":
                ok = status == 503 and code == "market_data_unavailable"
            elif name == "AUD 7-day fallback":
                ok = (status == 200 and body["currency"] == "AUD"
                      and body["seriesSource"] == "market_overview_sparkline"
                      and body["availableMetrics"] == ["price"]
                      and [point["value"] for point in body["prices"]] == [34467.89, 34567.89]
                      and body["marketCaps"] == [] and body["volumes"] == [])
            elif name == "AUD 30-day rate limit":
                ok = status == 429 and code == "market_data_rate_limited" and headers.get("Retry-After") == "37"
            elif name == "CHF quote rate limit":
                ok = status == 429 and code == "market_data_rate_limited" and headers.get("Retry-After") == "29"
            elif name.startswith("unsupported"):
                ok = status == 400 and code == "unsupported_currency"
            else:
                coin = body["coins"][0]
                ok = status == 200 and body["currency"] == "USD" and coin["priceUsd"] == 23456.78 and "price" not in coin
            print(f"{'PASS' if ok else 'FAIL'} {name} (HTTP {status}, code={code})", flush=True)
            if not ok:
                failures.append(name)
        except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
            print(f"FAIL {name} ({type(error).__name__})", flush=True)
            failures.append(name)
    return failures


def verify_mock_requests(log):
    expected = {
        ("/api/v3/coins/markets", "gbp", "", 200),
        ("/api/v3/coins/bitcoin/market_chart", "gbp", "7", 200),
        ("/api/v3/coins/bitcoin/market_chart", "cad", "7", 200),
        ("/api/v3/coins/bitcoin/market_chart", "nzd", "7", 200),
        ("/api/v3/coins/bitcoin/market_chart", "sgd", "7", 200),
        ("/api/v3/coins/bitcoin/market_chart", "nok", "7", 200),
        ("/api/v3/coins/markets", "eur", "", 200),
        ("/api/v3/coins/markets", "jpy", "", 500),
        ("/api/v3/coins/bitcoin/market_chart", "aud", "7", 429),
        ("/api/v3/coins/markets", "aud", "", 200),
        ("/api/v3/coins/bitcoin/market_chart", "aud", "30", 429),
        ("/api/v3/coins/markets", "chf", "", 429),
        ("/api/v3/coins/markets", "usd", "", 200),
    }
    actual = []
    for event in events(log):
        if event.get("event") != "request":
            continue
        url = urllib.parse.urlsplit(event.get("path", ""))
        query = urllib.parse.parse_qs(url.query)
        actual.append((url.path, query.get("vs_currency", [""])[0], query.get("days", [""])[0], event.get("statusCode")))
        if event.get("routeKey") != "coingecko" or event.get("method") != "GET":
            return False
    return len(actual) == len(expected) and set(actual) == expected


def main():
    enter_private_namespaces()
    if not (ROOT / "node_modules/next/dist/bin/next").is_file():
        raise RuntimeError("Install the repository's Node dependencies first")
    if shutil.which("postman") is None or shutil.which("node") is None:
        raise RuntimeError("Postman CLI and Node must be available on PATH")

    with tempfile.TemporaryDirectory(prefix="market-currency-regression-") as temporary:
        work = Path(temporary)
        app = work / "app"
        app.mkdir()
        for relative in SOURCE_FILES:
            source, target = ROOT / relative, app / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        (app / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for relative in (SIMULATION, MOCK / "config.yaml", MOCK / "default.js"):
            target = work / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        guard = work / "loopback-only.cjs"
        guard.write_text(GUARD)
        env = {key: os.environ[key] for key in ("HOME", "PATH") if key in os.environ}
        env.update({"TMPDIR": str(work), "LANG": "C.UTF-8", "NEXT_TELEMETRY_DISABLED": "1", "NO_PROXY": "*"})
        app_env = {**env, "COINGECKO_DEMO_API_KEY": "simulation-only",
                   "NODE_OPTIONS": f"--max-old-space-size=384 --require={json.dumps(str(guard))}"}
        guard_check = subprocess.run(
            ["node", "-e", "try { require('node:net').connect({host:'192.0.2.1',port:9}); process.exit(1); } catch (e) { process.exit(e.message.includes('blocks non-loopback') ? 0 : 1); }"],
            env=app_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        )
        if guard_check.returncode:
            raise RuntimeError("The local-only network guard did not activate")

        mock_log, mock_error, app_log = work / "mock.ndjson", work / "mock.err", work / "next.log"
        mock = server = None
        postman_state = Path.home() / ".postman"
        if not postman_state.is_dir():
            raise RuntimeError("The existing Postman state directory is required for temporary isolation")
        empty_postman_state = work / "postman-state"
        empty_postman_state.mkdir()
        # Reuse only installed runtime artifacts, not Postman settings or data.
        cached_runtimes = postman_state / "dataset-engine/extracted"
        copied_runtime = False
        if cached_runtimes.is_dir():
            for version in cached_runtimes.iterdir():
                if not version.is_dir() or version.is_symlink():
                    continue
                required = ("postman-dataset-engine", "jdbc-driver-host.jar", "xsv0.so")
                if not all((version / name).is_file() and not (version / name).is_symlink() for name in required):
                    continue
                copied_runtime = True
                for name in ("postman-dataset-engine", "jdbc-driver-host.jar", "libxlite.so", "xsv0.so"):
                    source = version / name
                    if source.is_file() and not source.is_symlink():
                        target = empty_postman_state / "dataset-engine/extracted" / version.name / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, target)
        if not copied_runtime:
            raise RuntimeError("Postman's cached dataset-engine runtime is required for the offline simulation")
        subprocess.run(["mount", "--make-rprivate", "/"], check=True, capture_output=True)
        subprocess.run(["mount", "--bind", str(empty_postman_state), str(postman_state)], check=True, capture_output=True)
        try:
            with mock_log.open("w") as output, mock_error.open("w") as error:
                mock = subprocess.Popen(
                    ["postman", "simulation", "run", str(SIMULATION), "--port", "auto", "--no-history", "--output", "ndjson"],
                    cwd=work, env=env, stdout=output, stderr=error, start_new_session=True,
                )
            listening = wait_for(mock, lambda: next((event for event in events(mock_log) if event.get("event") == "listening"), None), 120, "Postman simulation")
            mock_port = int(listening["port"])
            market_file = app / "src/lib/market-data.ts"
            source = market_file.read_text()
            if source.count(PROVIDER_BASE) != 1:
                raise RuntimeError("Provider base changed; review the isolated snapshot setup before rerunning")
            market_file.write_text(source.replace(PROVIDER_BASE, f'const COINGECKO_BASE = "http://127.0.0.1:{mock_port}/coingecko/api/v3";'))
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            with app_log.open("w") as output:
                server = subprocess.Popen(
                    ["node", "./node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", str(port)],
                    cwd=app, env=app_env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
                )
            wait_for(server, lambda: "Ready in" in app_log.read_text(errors="replace"), 120, "isolated Next.js server")
            failures = check_cases(f"http://127.0.0.1:{port}")
            if not verify_mock_requests(mock_log):
                failures.append("mock request evidence")
                print("FAIL expected requests did not reach the local mock", flush=True)
            else:
                print("PASS all 13 expected provider requests reached the local mock", flush=True)
            return 1 if failures else 0
        except Exception:
            for label, log in (("simulation", mock_error), ("app", app_log)):
                if log.exists():
                    print(f"{label} log tail:\n{log.read_text(errors='replace')[-2500:]}", file=sys.stderr)
            raise
        finally:
            stop(server)
            stop(mock)
            # The CLI may leave a short-lived worker holding the mount. It is
            # private to this namespace, so detach it before removing the temp tree.
            subprocess.run(["umount", "--lazy", str(postman_state)], check=True, capture_output=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"Simulation could not run: {error}", file=sys.stderr)
        sys.exit(1)
