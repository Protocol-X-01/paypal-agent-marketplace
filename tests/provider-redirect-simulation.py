#!/usr/bin/env python3
"""Exercise real provider callers against synthetic HTTPS and Postman mocks."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
import market_currency_simulation as isolation

ROOT = Path(__file__).resolve().parents[1]
MOCK = Path('postman/mocks/provider-redirect-regression')
SIM = Path('postman/simulations/provider-redirect-regression.sim.yaml')
COLLECTION = Path('postman/simulations/provider-redirect-checks')
DRIVER = Path('tests/provider-redirect-driver.cjs')
SOURCES = tuple(map(Path, ('src/lib/channel3.ts', 'src/lib/channel3-storefront.ts', 'src/lib/marketplace-safety.ts', 'src/lib/market-data.ts', 'src/lib/market-assets.ts', 'src/lib/paypal.ts')))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    isolation.__file__ = __file__
    isolation.enter_private_namespaces()
    if not all(shutil.which(name) for name in ('postman', 'node', 'openssl')) or not (ROOT / 'node_modules/typescript').is_dir():
        raise RuntimeError('Postman, Node, OpenSSL and installed project dependencies are required')
    with tempfile.TemporaryDirectory(prefix='provider-redirect-') as temporary:
        work = Path(temporary)
        for relative in (SIM, MOCK / 'config.yaml', MOCK / 'default.js', DRIVER, *SOURCES):
            target = work / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        shutil.copytree(ROOT / COLLECTION, work / COLLECTION)
        (work / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        source_hashes = {source: digest(work / source) for source in SOURCES}
        upstream_port, destination_port = free_port(), free_port()
        while destination_port == upstream_port:
            destination_port = free_port()
        mock_source = work / MOCK / 'default.js'
        mock_source.write_text(mock_source.read_text().replace('__SYNTHETIC_ORIGIN__', f'https://127.0.0.1:{upstream_port}').replace('__SYNTHETIC_DESTINATION__', f'https://localhost:{destination_port}'))

        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', str(work / 'key.pem'), '-out', str(work / 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], check=True, capture_output=True, timeout=30)
        temporary_home = work / 'home'
        temporary_home.mkdir()
        cached_runtimes = Path.home() / '.postman/dataset-engine/extracted'
        if cached_runtimes.is_dir():
            for version in cached_runtimes.iterdir():
                if not version.is_dir() or version.is_symlink():
                    continue
                for name in ('postman-dataset-engine', 'jdbc-driver-host.jar', 'libxlite.so', 'xsv0.so'):
                    source = version / name
                    if source.is_file() and not source.is_symlink():
                        target = temporary_home / '.postman/dataset-engine/extracted' / version.name / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, target)
        guard = work / 'loopback-only.cjs'
        guard.write_text(isolation.GUARD)
        env = {'PATH': os.environ['PATH'], 'HOME': str(temporary_home), 'TMPDIR': str(work), 'LANG': 'C.UTF-8', 'NO_PROXY': '*'}
        node_env = {**env, 'NODE_EXTRA_CA_CERTS': str(work / 'cert.pem'), 'NODE_OPTIONS': f'--dns-result-order=ipv4first --require={json.dumps(str(guard))}'}
        mock = None
        mock_log, mock_error = work / 'mock.ndjson', work / 'mock.err'
        try:
            with mock_log.open('w') as output, mock_error.open('w') as error:
                mock = subprocess.Popen(['postman', 'simulation', 'run', str(SIM), '--port', 'auto', '--no-history', '--output', 'ndjson'], cwd=work, env=env, stdout=output, stderr=error, start_new_session=True)
            listening = isolation.wait_for(mock, lambda: next((event for event in isolation.events(mock_log) if event.get('event') == 'listening'), None), 120, 'Postman simulation')
            base = f'http://127.0.0.1:{int(listening["port"])}'
            failures = []
            driver = subprocess.run(['node', str(DRIVER), str(listening['port']), str(upstream_port), str(destination_port), str(work)], cwd=work, env=node_env, text=True, capture_output=True, timeout=45)
            print(driver.stdout, end='', flush=True)
            if driver.stderr:
                print(driver.stderr, end='', file=sys.stderr, flush=True)
            if driver.returncode:
                failures.append('provider redirect checks')
            lint = subprocess.run(['postman', 'collection', 'lint', str(COLLECTION)], cwd=work, env=env, text=True, capture_output=True, timeout=60)
            print(lint.stdout, end='', flush=True)
            if lint.stderr:
                print(lint.stderr, end='', file=sys.stderr, flush=True)
            if lint.returncode:
                failures.append('collection lint')
            collection = subprocess.run(['postman', 'collection', 'run', str(COLLECTION), '--env-var', f'baseUrl={base}', '--no-report-events'], cwd=work, env=env, text=True, capture_output=True, timeout=90)
            print(collection.stdout, end='', flush=True)
            if collection.stderr:
                print(collection.stderr, end='', file=sys.stderr, flush=True)
            if collection.returncode:
                failures.append('collection assertions')
            events = [event for event in isolation.events(mock_log) if event.get('event') == 'request' and event.get('routeKey') == 'upstream']
            provider = [event for event in events if event.get('path') not in ('/stats', '/same-target')]
            if len(provider) == 21 and sum(event.get('statusCode') == 200 for event in provider) == 9 and sum(event.get('statusCode') == 307 for event in provider) == 12:
                print('PASS mock log recorded all 21 expected provider requests', flush=True)
            else:
                print('FAIL mock log did not record the expected provider requests', flush=True)
                failures.append('mock log')
            for source, source_hash in source_hashes.items():
                if digest(ROOT / source) != source_hash:
                    print(f'FAIL {source} changed during the simulation', flush=True)
                    failures.append('source changed')
                else:
                    print(f'PASS {source} snapshot unchanged (SHA-256 {source_hash})', flush=True)
            return 1 if failures else 0
        finally:
            isolation.stop(mock)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f'Simulation could not run: {type(error).__name__}', file=sys.stderr)
        sys.exit(1)
