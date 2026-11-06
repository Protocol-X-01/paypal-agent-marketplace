#!/usr/bin/env python3
"""Run the real webhook receiver and adapter against a synthetic local provider."""

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
SIMULATION = Path('postman/simulations/paypal-webhook-verification.sim.yaml')
MOCK = Path('postman/mocks/paypal-webhook-verification')
COLLECTION = Path('postman/collections/PayPal Webhook Verification')
SOURCE_FILES = (
    'src/lib/paypal.ts',
    'src/app/api/webhooks/paypal/route.ts',
    'tests/paypal-webhook-driver.cjs',
)


def driver_ready(path):
    for line in path.read_text(errors='replace').splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if value.get('ready') and isinstance(value.get('port'), int):
            return value
    return None


def read_fixture_stats(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{port}/paypal/_fixture/stats', timeout=5) as response:
        return json.load(response)


def check_mock_log(path):
    requests = [event for event in isolation.events(path) if event.get('event') == 'request']
    if any(event.get('routeKey') != 'paypal' for event in requests):
        return False
    return any(event.get('path') == '/v1/oauth2/token' and event.get('statusCode') == 200 for event in requests) and sum(
        event.get('path') == '/v1/notifications/verify-webhook-signature' and event.get('statusCode') in (200, 503)
        for event in requests
    ) >= 3


def main():
    # Reuse the project's reviewed loopback-only network and mount isolation.
    isolation.__file__ = __file__
    isolation.enter_private_namespaces()
    if not (ROOT / 'node_modules/typescript/lib/typescript.js').is_file():
        raise RuntimeError('Installed repository Node dependencies are required')
    if not shutil.which('postman') or not shutil.which('node'):
        raise RuntimeError('Postman CLI and Node must be available on PATH')

    with tempfile.TemporaryDirectory(prefix='paypal-webhook-verification-') as temporary:
        work = Path(temporary)
        for relative in (*SOURCE_FILES, SIMULATION, MOCK / 'config.yaml', MOCK / 'default.js'):
            target = work / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        shutil.copytree(ROOT / COLLECTION, work / COLLECTION)
        (work / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)

        guard = work / 'loopback-only.cjs'
        guard.write_text(isolation.GUARD)
        env = {key: os.environ[key] for key in ('HOME', 'PATH') if key in os.environ}
        env.update({'TMPDIR': str(work), 'LANG': 'C.UTF-8', 'NO_PROXY': '*', 'NEXT_TELEMETRY_DISABLED': '1'})
        driver_env = {**env, 'NODE_OPTIONS': f'--require={json.dumps(str(guard))}',
                      'PAYPAL_ENV': 'sandbox', 'PAYPAL_CLIENT_ID': 'fixture-client',
                      'PAYPAL_CLIENT_SECRET': 'fixture-credential', 'PAYPAL_WEBHOOK_ID': 'FIXTUREWEBHOOK'}

        # The mock and collection need no signed-in workspace. Bind a fresh
        # settings directory only inside this private mount namespace.
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
        mock = driver = None
        mock_log, mock_error, driver_log = work / 'mock.ndjson', work / 'mock.err', work / 'driver.log'
        try:
            with mock_log.open('w') as output, mock_error.open('w') as error:
                mock = subprocess.Popen(
                    ['postman', 'simulation', 'run', str(SIMULATION), '--port', 'auto', '--no-history', '--output', 'ndjson'],
                    cwd=work, env=env, stdout=output, stderr=error, start_new_session=True,
                )
            listening = isolation.wait_for(mock, lambda: next((event for event in isolation.events(mock_log) if event.get('event') == 'listening'), None), 120, 'Postman simulation')
            mock_port = int(listening['port'])
            with driver_log.open('w') as output:
                driver = subprocess.Popen(
                    ['node', str(work / 'tests/paypal-webhook-driver.cjs'), str(mock_port)],
                    cwd=work, env=driver_env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
                )
            ready = isolation.wait_for(driver, lambda: driver_ready(driver_log), 30, 'isolated webhook receiver')
            base = f"http://127.0.0.1:{ready['port']}"
            run = subprocess.run(
                ['postman', 'collection', 'run', str(work / COLLECTION), '--env-var', f'baseUrl={base}', '--no-report-events'],
                cwd=work, env=env, text=True, capture_output=True, timeout=90,
            )
            # The API-builder skill requires preserving this exact output.
            print(run.stdout, end='', flush=True)
            if run.stderr:
                print(run.stderr, end='', file=sys.stderr, flush=True)
            failures = [] if run.returncode == 0 else ['Postman collection']
            stats = read_fixture_stats(mock_port)
            expected = ['synthetic-success', 'synthetic-rejected', 'synthetic-unavailable', 'synthetic-slow']
            if stats.get('token') == 1 and stats.get('verification') == expected and check_mock_log(mock_log):
                print('PASS mock recorded the expected OAuth and verification requests only', flush=True)
            else:
                failures.append('mock request evidence')
                print('FAIL expected provider requests were not observed in the mock', flush=True)
            return 1 if failures else 0
        except Exception:
            for label, log in (('simulation', mock_error), ('receiver', driver_log)):
                if log.exists():
                    print(f'{label} log tail:\n{log.read_text(errors="replace")[-2000:]}', file=sys.stderr)
            raise
        finally:
            isolation.stop(driver)
            isolation.stop(mock)
            subprocess.run(['umount', str(postman_state)], check=True, capture_output=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired, urllib.error.URLError) as error:
        print(f'Simulation could not run: {error}', file=sys.stderr)
        sys.exit(1)
