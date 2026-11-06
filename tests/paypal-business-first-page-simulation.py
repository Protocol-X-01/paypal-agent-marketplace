#!/usr/bin/env python3
"""Exercise the real experimental adapter against a synthetic Postman mock."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
import market_currency_simulation as isolation

ROOT = Path(__file__).resolve().parents[1]
SIMULATION = Path('postman/simulations/paypal-business-first-page.sim.yaml')
MOCK = Path('postman/mocks/paypal-business-first-page')
COLLECTION = Path('postman/collections/PayPal Transaction Search Experimental')
SOURCES = ('src/lib/paypal-business-sample.ts', 'tests/paypal-business-first-page-driver.cjs')


def digests():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}


def main():
    os.umask(0o077)
    isolation.__file__ = str(Path(__file__).resolve())
    isolation.enter_private_namespaces()
    if not (ROOT / 'node_modules/typescript').is_dir() or not shutil.which('postman') or not shutil.which('node'):
        raise RuntimeError('Node dependencies and Postman CLI are required')
    before = digests()
    with tempfile.TemporaryDirectory(prefix='paypal-business-first-page-') as temporary:
        work = Path(temporary)
        for relative in (*SOURCES, SIMULATION, MOCK / 'config.yaml', MOCK / 'default.js'):
            target = work / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        shutil.copytree(ROOT / COLLECTION, work / COLLECTION)
        (work / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)

        state = Path.home() / '.postman'
        if not state.is_dir() or state.is_symlink():
            raise RuntimeError('An ordinary Postman state directory is required for masking')
        private_state = work / 'postman-state'
        private_state.mkdir()
        cached = state / 'dataset-engine/extracted'
        if cached.is_dir():
            for version in cached.iterdir():
                if not version.is_dir() or version.is_symlink():
                    continue
                for name in ('postman-dataset-engine', 'jdbc-driver-host.jar', 'libxlite.so', 'xsv0.so'):
                    source = version / name
                    if source.is_file() and not source.is_symlink():
                        target = private_state / 'dataset-engine/extracted' / version.name / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, target)
        subprocess.run(['mount', '--make-rprivate', '/'], check=True, capture_output=True)
        subprocess.run(['mount', '--bind', str(private_state), str(state)], check=True, capture_output=True)
        env = {key: os.environ[key] for key in ('HOME', 'PATH') if key in os.environ}
        env.update({'TMPDIR': str(work), 'LANG': 'C.UTF-8', 'NO_PROXY': '*', 'NEXT_TELEMETRY_DISABLED': '1'})
        log, errors = work / 'mock.ndjson', work / 'mock.err'
        mock = None
        try:
            with log.open('w') as output, errors.open('w') as error:
                mock = subprocess.Popen(
                    ['postman', 'simulation', 'run', str(SIMULATION), '--port', 'auto', '--no-history', '--output', 'ndjson'],
                    cwd=work, env=env, stdout=output, stderr=error, start_new_session=True,
                )
            listening = isolation.wait_for(mock, lambda: next((event for event in isolation.events(log) if event.get('event') == 'listening'), None), 60, 'Postman simulation')
            port = int(listening['port'])
            guard = work / 'loopback-only.cjs'
            guard.write_text(isolation.GUARD)
            driver_env = {**env, 'NODE_OPTIONS': f'--require={json.dumps(str(guard))}'}
            run = subprocess.run(
                ['node', '--max-old-space-size=256', str(work / SOURCES[1]), str(port)],
                cwd=work, env=driver_env, capture_output=True, text=True, timeout=30,
            )
            print(run.stdout, end='', flush=True)
            if run.stderr:
                print(run.stderr, end='', file=sys.stderr, flush=True)
            if run.returncode:
                return 1

            collection = subprocess.run(
                ['postman', 'collection', 'run', str(work / COLLECTION), '--env-var', f'baseUrl=http://127.0.0.1:{port}/paypal', '--no-report-events'],
                cwd=work, env=env, capture_output=True, text=True, timeout=60,
            )
            print(collection.stdout, end='', flush=True)
            if collection.stderr:
                print(collection.stderr, end='', file=sys.stderr, flush=True)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f'http://127.0.0.1:{port}/paypal/_fixture/stats', timeout=5) as response:
                stats = json.load(response)
            expected = [f'2026-{month:02d}-01T00:00:00Z' for month in range(1, 8)] + ['2026-01-01T00:00:00Z']
            ok = stats.get('calls') == expected and stats.get('redirectDestinationHits') == 0
            requests = [event for event in isolation.events(log) if event.get('event') == 'request'
                        and str(event.get('path', '')).split('?', 1)[0] == '/v1/reporting/transactions']
            ok = ok and len(requests) >= 7 and all(event.get('routeKey') == 'paypal' for event in requests)
            print(f'{"PASS" if ok else "FAIL"} mock recorded the expected synthetic requests and no redirect destination hit', flush=True)
            if not ok:
                summary = {'calls': stats.get('calls'), 'redirectDestinationHits': stats.get('redirectDestinationHits'),
                           'events': [{key: event.get(key) for key in ('event', 'routeKey', 'path', 'statusCode')} for event in isolation.events(log)]}
                print(json.dumps(summary), flush=True)
            unchanged = before == digests()
            print(f'{"PASS" if unchanged else "FAIL"} adapter and driver remained unchanged during the simulation', flush=True)
            return 0 if collection.returncode == 0 and ok and unchanged else 1
        finally:
            isolation.stop(mock)
            subprocess.run(['umount', str(state)], check=True, capture_output=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired, urllib.error.URLError) as error:
        print(f'Simulation could not run: {error}', file=sys.stderr)
        sys.exit(1)
