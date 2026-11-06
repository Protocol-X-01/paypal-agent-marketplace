#!/usr/bin/env python3
"""Run the real OTLP exporter and privacy filter against a local Postman mock."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request

sys.dont_write_bytecode = True
import market_currency_simulation as isolation

ROOT = Path(__file__).resolve().parents[1]
SIMULATION = Path('postman/simulations/elastic-otlp-privacy.sim.yaml')
MOCK = Path('postman/mocks/elastic-otlp-privacy')
COLLECTION = Path('postman/simulations/elastic-otlp-checks')
SOURCES = (Path('src/lib/telemetry-privacy.ts'), Path('src/lib/telemetry-exporter.ts'))
DRIVER = Path('tests/elastic-otlp-exporter.cjs')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    isolation.__file__ = __file__
    isolation.enter_private_namespaces()
    if not shutil.which('postman') or not shutil.which('node') or not all(
        (ROOT / path).is_dir() for path in ('node_modules/@vercel/otel', 'node_modules/@opentelemetry/exporter-trace-otlp-proto')
    ):
        raise RuntimeError('Postman CLI, Node and installed repository dependencies are required')

    with tempfile.TemporaryDirectory(prefix='elastic-otlp-privacy-') as temporary:
        work = Path(temporary)
        for relative in (SIMULATION, MOCK / 'config.yaml', MOCK / 'default.js', *SOURCES, DRIVER):
            target = work / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        shutil.copytree(ROOT / COLLECTION, work / COLLECTION)
        (work / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        source_hashes = {source: digest(work / source) for source in SOURCES}

        guard = work / 'loopback-only.cjs'
        guard.write_text(isolation.GUARD)
        env = {key: os.environ[key] for key in ('HOME', 'PATH') if key in os.environ}
        env.update({'TMPDIR': str(work), 'LANG': 'C.UTF-8', 'NO_PROXY': '*'})
        node_env = {**env, 'NODE_OPTIONS': f'--require={json.dumps(str(guard))}'}
        guard_check = subprocess.run(
            ['node', '-e', "try { require('node:net').connect({host:'192.0.2.1',port:9}); process.exit(1); } catch (e) { process.exit(e.message.includes('blocks non-loopback') ? 0 : 1); }"],
            env=node_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        )
        if guard_check.returncode:
            raise RuntimeError('The loopback-only network guard did not activate')

        postman_state = Path.home() / '.postman'
        if not postman_state.is_dir():
            raise RuntimeError('The existing Postman state directory is required for temporary isolation')
        empty_state = work / 'postman-state'
        empty_state.mkdir()
        cached_runtimes = postman_state / 'dataset-engine/extracted'
        if cached_runtimes.is_dir():
            for version in cached_runtimes.iterdir():
                if not version.is_dir() or version.is_symlink():
                    continue
                for name in ('postman-dataset-engine', 'jdbc-driver-host.jar', 'libxlite.so', 'xsv0.so'):
                    source = version / name
                    if source.is_file() and not source.is_symlink():
                        target = empty_state / 'dataset-engine/extracted' / version.name / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, target)
        subprocess.run(['mount', '--make-rprivate', '/'], check=True, capture_output=True)
        subprocess.run(['mount', '--bind', str(empty_state), str(postman_state)], check=True, capture_output=True)
        mock = None
        mock_log, mock_error = work / 'mock.ndjson', work / 'mock.err'
        try:
            with mock_log.open('w') as output, mock_error.open('w') as error:
                mock = subprocess.Popen(
                    ['postman', 'simulation', 'run', str(SIMULATION), '--port', 'auto', '--no-history', '--output', 'ndjson'],
                    cwd=work, env=env, stdout=output, stderr=error, start_new_session=True,
                )
            listening = isolation.wait_for(mock, lambda: next((event for event in isolation.events(mock_log) if event.get('event') == 'listening'), None), 120, 'Postman simulation')
            base = f'http://127.0.0.1:{int(listening["port"])}'
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                closed_port = sock.getsockname()[1]
            closed_base = f'http://127.0.0.1:{closed_port}'
            failures = []
            driver = subprocess.run(['node', str(DRIVER), f'{base}/elastic', f'{closed_base}/elastic'], cwd=work, env=node_env,
                                    text=True, capture_output=True, timeout=70)
            print(driver.stdout, end='', flush=True)
            if driver.stderr:
                print(driver.stderr, end='', file=sys.stderr, flush=True)
            if driver.returncode:
                failures.append('real exporter checks')
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(base + '/elastic/__elastic__/stats', timeout=10) as response:
                    print('Synthetic mock counters:', response.read().decode('utf8'), flush=True)

            lint = subprocess.run(['postman', 'collection', 'lint', str(COLLECTION)], cwd=work, env=env,
                                  text=True, capture_output=True, timeout=60)
            print(lint.stdout, end='', flush=True)
            if lint.stderr:
                print(lint.stderr, end='', file=sys.stderr, flush=True)
            if lint.returncode:
                failures.append('Postman collection lint')
            run = subprocess.run(['postman', 'collection', 'run', str(COLLECTION), '--env-var', f'baseUrl={base}', '--no-report-events'],
                                 cwd=work, env=env, text=True, capture_output=True, timeout=90)
            print(run.stdout, end='', flush=True)
            if run.stderr:
                print(run.stderr, end='', file=sys.stderr, flush=True)
            if run.returncode:
                failures.append('Postman collection assertions')

            events = [event for event in isolation.events(mock_log) if event.get('event') == 'request']
            expected = {('/v1/traces', 'POST', 200), ('/bad-request/v1/traces', 'POST', 400),
                        ('/unavailable/v1/traces', 'POST', 503), ('/redirect/v1/traces', 'POST', 307),
                        ('/__elastic__/stats', 'GET', 200)}
            actual = {(e.get('path'), e.get('method'), e.get('statusCode')) for e in events if e.get('routeKey') == 'elastic'}
            if expected.issubset(actual):
                print('PASS all exporter configurations exercised the expected mock paths and the Postman check', flush=True)
            else:
                print('FAIL expected mock request evidence was incomplete', flush=True)
                failures.append('mock request evidence')
            for source, source_hash in source_hashes.items():
                if digest(ROOT / source) != source_hash:
                    print(f'FAIL {source} changed while the simulation was running', flush=True)
                    failures.append('source changed')
                else:
                    print(f'PASS {source} snapshot remained unchanged (SHA-256 {source_hash})', flush=True)
            return 1 if failures else 0
        except Exception:
            if mock_error.exists():
                print(f'Simulation error log tail:\n{mock_error.read_text(errors="replace")[-2000:]}', file=sys.stderr)
            raise
        finally:
            isolation.stop(mock)
            subprocess.run(['umount', str(postman_state)], check=True, capture_output=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f'Simulation could not run: {error}', file=sys.stderr)
        sys.exit(1)
