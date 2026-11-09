#!/usr/bin/env python3
"""Run the real storefront route functions against a loopback Postman mock.

Unlike channel3_storefront_simulation.py, this avoids starting Next.js. It is
a smaller integration check, not a substitute for the full runtime test.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
import market_currency_simulation as isolation


ROOT = Path(__file__).resolve().parents[1]
SIMULATION_FILES = (
    "postman/simulations/channel3-storefront-regression.sim.yaml",
    "postman/mocks/channel3-storefront-regression/config.yaml",
    "postman/mocks/channel3-storefront-regression/default.js",
)
SOURCE_FILES = (
    "src/lib/channel3.ts",
    "src/lib/channel3-storefront.ts",
    "src/lib/channel3-catalog.ts",
    "src/lib/channel3-rate-limit.ts",
    "src/lib/mobile-web-cors.ts",
    "src/lib/request-limits.ts",
    "src/app/api/marketplace/search/route.ts",
    "src/app/api/marketplace/catalog/route.ts",
)

# Transpile the checked-in TypeScript in memory and invoke the actual route
# functions with NextRequest. The HTTPS check is adjusted only in that in-memory
# copy, so the adapter can reach the loopback-only mock. Production source stays
# HTTPS-only. All other imports, including rate limiting and CORS, are real.
BRIDGE = r"""
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = process.env.PAYPAL_STOREFRONT_REPO;
const ts = require(root + '/node_modules/typescript');
const { createRequire } = require('node:module');
const nativeRequire = createRequire(root + '/package.json');
const source = (path) => fs.readFileSync(root + '/' + path, 'utf8');
function load(code, aliases = {}) {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const request = (name) => Object.hasOwn(aliases, name) ? aliases[name] : nativeRequire(name);
  new Function('exports', 'require', 'module', js)(module.exports, request, module);
  return module.exports;
}
const storefront = load(source('src/lib/channel3-storefront.ts'));
let providerSource = source('src/lib/channel3.ts');
const guard = 'if (baseUrl.protocol !== "https:") throw new Error("Channel3 base URL must use HTTPS");';
if (providerSource.split(guard).length !== 2) throw new Error('Review the changed transport guard');
providerSource = providerSource.replace(guard,
  'if (baseUrl.protocol !== "http:" || baseUrl.hostname !== "127.0.0.1") throw new Error("Simulation requires loopback");');
const provider = load(providerSource, { 'server-only': {}, '@/lib/channel3-storefront': storefront });
const catalog = load(source('src/lib/channel3-catalog.ts'));
const requestLimits = load(source('src/lib/request-limits.ts'), { 'server-only': {} });
const limiter = load(source('src/lib/channel3-rate-limit.ts'), { './request-limits': requestLimits });
const cors = load(source('src/lib/mobile-web-cors.ts'), { 'server-only': {} });
const aliases = {
  '@/lib/channel3': provider,
  '@/lib/channel3-storefront': storefront,
  '@/lib/channel3-catalog': catalog,
  '@/lib/channel3-rate-limit': limiter,
  '@/lib/request-limits': requestLimits,
  '@/lib/mobile-web-cors': cors,
};
const search = load(source('src/app/api/marketplace/search/route.ts'), aliases);
const browse = load(source('src/app/api/marketplace/catalog/route.ts'), aliases);
const { NextRequest } = nativeRequire('next/server');
(async () => {
  process.env.CHANNEL3_COLLECTION_ID = 'fixture-collection';
  for (const [country, currency] of [['GB', 'GBP'], ['US', 'USD']]) {
    for (const operation of ['search', 'catalog']) {
      const request = operation === 'search'
        ? new NextRequest('http://localhost:3000/api/marketplace/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'headphones', limit: 1, storefront: country }),
          })
        : new NextRequest('http://localhost:3000/api/marketplace/catalog?section=audio&storefront=' + country);
      const response = operation === 'search' ? await search.POST(request) : await browse.GET(request);
      const body = await response.json();
      const ok = response.status === 200 && body.provider === 'Channel3'
        && body.storefront === country && body.currency === currency
        && (operation !== 'catalog' || body.section === 'audio')
        && body.products?.length === 1
        && body.products[0]?.id === `fixture-${country}-${currency}-en`;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${country}/${currency} ${operation} (HTTP ${response.status})`);
      if (!ok) process.exitCode = 1;
    }
  }
  const makePagedRequest = (pageToken, storefront = 'GB') => new NextRequest('http://localhost:3000/api/marketplace/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'paged headphones', limit: 1, storefront, ...(pageToken ? { pageToken } : {}) }),
  });
  const first = await search.POST(makePagedRequest());
  const firstBody = await first.json();
  const second = await search.POST(makePagedRequest(firstBody.nextPageToken));
  const secondBody = await second.json();
  const mismatch = await search.POST(makePagedRequest(firstBody.nextPageToken, 'US'));
  const pagedOk = first.status === 200 && firstBody.products?.[0]?.id === 'fixture-first'
    && typeof firstBody.nextPageToken === 'string' && firstBody.nextPageToken !== 'fixture-page-two'
    && second.status === 200 && secondBody.products?.[0]?.id === 'fixture-target'
    && secondBody.nextPageToken === null && mismatch.status === 400;
  console.log(`${pagedOk ? 'PASS' : 'FAIL'} scoped search continuation and cross-region rejection`);
  if (!pagedOk) process.exitCode = 1;

  // Run the maintained Postman request against the real route function, behind
  // a loopback-only Node HTTP bridge. This is not the Next.js HTTP server.
  const app = http.createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      if (incoming.method !== 'POST' || incoming.url !== '/api/marketplace/search') {
        outgoing.writeHead(404).end(); return;
      }
      const request = new NextRequest(`http://127.0.0.1:${app.address().port}${incoming.url}`, {
        method: 'POST', headers: incoming.headers, body: Buffer.concat(chunks),
      });
      const response = await search.POST(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500).end(); }
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  const command = spawn('postman', [
    'collection', 'run', root + '/postman/collections/PayPal Market APIs',
    '-i', 'Search live marketplace products and offers', '--env-var', `baseUrl=${baseUrl}`,
    '--env-var', 'mockLocaleFixture=enabled', '--no-report-events',
  ], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS} --max-old-space-size=256` } });
  const exitCode = await new Promise((resolve, reject) => {
    command.once('error', reject);
    command.once('exit', resolve);
  });
  await new Promise((resolve) => app.close(resolve));
  console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} Postman search collection request against route bridge`);
  if (exitCode !== 0) process.exitCode = 1;
})().catch(() => { console.error('FAIL route bridge'); process.exitCode = 1; });
"""


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def main():
    os.umask(0o077)
    # Reuse the reviewed network/mount namespace guard. No real app environment
    # is inherited by the isolated processes.
    isolation.__file__ = str(Path(__file__).resolve())
    isolation.enter_private_namespaces()
    if not (ROOT / "node_modules/typescript").is_dir() or not shutil.which("postman") or not shutil.which("node"):
        raise RuntimeError("Installed Node dependencies and Postman CLI are required")
    before = hashes()

    with tempfile.TemporaryDirectory(prefix="paypal-channel3-bridge-") as temporary:
        work = Path(temporary)
        for name in SIMULATION_FILES:
            dest = work / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, dest)

        # Hide the user's Postman settings inside this private mount namespace;
        # only already-installed, non-secret runtime binaries are copied.
        state = Path.home() / ".postman"
        if not state.is_dir() or state.is_symlink():
            raise RuntimeError("An existing ordinary Postman state directory is required for masking")
        private_state = work / "postman-state"
        private_state.mkdir()
        cached_runtimes = state / "dataset-engine/extracted"
        if cached_runtimes.is_dir():
            for version in cached_runtimes.iterdir():
                if not version.is_dir() or version.is_symlink():
                    continue
                for name in ("postman-dataset-engine", "jdbc-driver-host.jar", "libxlite.so", "xsv0.so"):
                    source = version / name
                    if source.is_file() and not source.is_symlink():
                        dest = private_state / "dataset-engine/extracted" / version.name / name
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, dest)
        subprocess.run(["mount", "--make-rprivate", "/"], check=True, capture_output=True)
        subprocess.run(["mount", "--bind", str(private_state), str(state)], check=True, capture_output=True)

        clean_env = {key: os.environ[key] for key in ("HOME", "PATH") if key in os.environ}
        clean_env.update({"TMPDIR": str(work), "LANG": "C.UTF-8", "NO_PROXY": "*", "NEXT_TELEMETRY_DISABLED": "1"})
        mocklog, mockerr = work / "mock.ndjson", work / "mock.err"
        mock = None
        try:
            with mocklog.open("w") as output, mockerr.open("w") as error:
                mock = subprocess.Popen(
                    ["postman", "simulation", "run", SIMULATION_FILES[0], "--port", "auto", "--no-history", "--output", "ndjson"],
                    cwd=work, env=clean_env, stdout=output, stderr=error, start_new_session=True,
                )
            listening = isolation.wait_for(
                mock, lambda: next((event for event in isolation.events(mocklog) if event.get("event") == "listening"), None),
                60, "Postman simulation",
            )
            guard = work / "network-guard.cjs"
            guard.write_text(isolation.GUARD, encoding="utf-8")
            app_env = {
                **clean_env,
                "PAYPAL_STOREFRONT_REPO": str(ROOT),
                "CHANNEL3_API_KEY": "simulation-only",
                "CHANNEL3_BASE_URL": f'http://127.0.0.1:{int(listening["port"])}/channel3',
                "NODE_OPTIONS": f"--require={json.dumps(str(guard))}",
            }
            run = subprocess.run(
                ["node", "--max-old-space-size=256", "-e", BRIDGE],
                cwd=work, env=app_env, text=True, capture_output=True, timeout=40,
            )
            print(run.stdout, end="", flush=True)
            if run.returncode:
                print("FAIL route bridge", flush=True)
                return 1
            events = [event for event in isolation.events(mocklog) if event.get("event") == "request"]
            paths = [event.get("path") for event in events]
            mock_ok = len(events) == 7 and all(
                event.get("method") == "POST" and event.get("routeKey") == "channel3" and event.get("statusCode") == 200
                for event in events
            ) and paths.count("/v1/search") == 5 and paths.count("/v1/browse") == 2
            print(f'{"PASS" if mock_ok else "FAIL"} mock recorded 5 search and 2 browse requests', flush=True)
            stable = before == hashes()
            print(f'{"PASS" if stable else "FAIL"} source files remained unchanged during the run', flush=True)
            return 0 if mock_ok and stable else 1
        finally:
            isolation.stop(mock)


if __name__ == "__main__":
    sys.exit(main())
