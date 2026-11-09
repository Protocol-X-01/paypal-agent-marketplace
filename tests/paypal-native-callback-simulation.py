#!/usr/bin/env python3
"""Run current native-auth code against a fictional local Postman OIDC provider.

This isolates networking and Postman state. It neither enables sign-in nor uses
project credentials. The in-memory store models sequencing, not PostgreSQL.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
SOURCE = (
    'src/lib/customer-auth/config.ts',
    'src/lib/customer-auth/provider.ts',
    'src/lib/customer-auth/provider-callback.ts',
    'src/lib/customer-auth/native-protocol.ts',
    'src/lib/customer-auth/native-store.ts',
    'src/lib/customer-auth/native-controller.ts',
    'src/lib/customer-auth/store.ts',
    'src/lib/customer-auth/controller.ts',
    'tests/paypal-native-callback-simulation.py',
    'tests/paypal-native-callback-simulation-driver.cjs',
    'postman/mocks/paypal-native-oidc-fixture/config.yaml',
    'postman/mocks/paypal-native-oidc-fixture/default.js',
    'postman/simulations/paypal-native-callback-regression.sim.yaml',
)
LIMIT, PROCESS_LIMIT, FLOOR, TIMEOUT = 1800, 12, 1536, 120
GUARD = r'''
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === 'number') options = { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (typeof options === 'string') options = { path: options };
  const host = options?.host || 'localhost';
  if (!options?.path && !['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('fictional simulation blocks external TCP');
  return connect.apply(this, args);
};
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hashes(base):
    return {name: digest(base / name) for name in SOURCE}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    path.chmod(0o600)


def memory():
    line = next(line for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    return int(line.split()[1]) / 1024


def disk(out):
    return min(shutil.disk_usage(out).free, shutil.disk_usage('/tmp').free) / 1048576


def tree(pid):
    rows = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            values = {line.split(':', 1)[0]: line.split(':', 1)[1].strip() for line in (entry / 'status').read_text().splitlines()}
            rows[int(entry.name)] = (int(values['PPid']), int(values.get('VmRSS', '0 kB').split()[0]) / 1024)
        except (OSError, KeyError, ValueError):
            pass
    owned = {pid}
    while True:
        expanded = owned | {child for child, (parent, _) in rows.items() if parent in owned}
        if expanded == owned:
            break
        owned = expanded
    return sum(rows[child][1] for child in owned if child in rows), sum(child in rows for child in owned)


def stop(process):
    if process is None or process.poll() is not None:
        return
    for sig, timeout in ((signal.SIGINT, 5), (signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            pass
    raise RuntimeError('Owned simulation process did not exit')


def events(path):
    if not path.exists():
        return []
    result = []
    for line in path.read_text().splitlines():
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return result


def inner(out):
    if str(os.stat('/proc/self/ns/net').st_ino) == os.environ.get('PARENT_NET') or str(os.stat('/proc/self/ns/mnt').st_ino) == os.environ.get('PARENT_MNT'):
        raise RuntimeError('Private network and mount namespaces required')
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True, capture_output=True)
    state = Path.home() / '.postman'
    if not state.is_dir() or state.is_symlink():
        raise RuntimeError('Ordinary Postman state required for masking')
    private = out / 'postman-state'
    private.mkdir(mode=0o700)
    cached = state / 'dataset-engine/extracted'
    if cached.is_dir():
        for version in cached.iterdir():
            if not version.is_dir() or version.is_symlink():
                continue
            for name in ('postman-dataset-engine', 'jdbc-driver-host.jar', 'libxlite.so', 'xsv0.so'):
                source = version / name
                if source.is_file() and not source.is_symlink():
                    target = private / 'dataset-engine/extracted' / version.name / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
    subprocess.run(['mount', '--make-rprivate', '/'], check=True, capture_output=True)
    subprocess.run(['mount', '--bind', str(private), str(state)], check=True, capture_output=True)
    mock = None
    try:
        snapshot = out / 'snapshot'
        env = {key: os.environ[key] for key in ('HOME', 'PATH') if key in os.environ}
        env.update({'LANG': 'C.UTF-8', 'TZ': 'Etc/UTC', 'NO_PROXY': '*', 'TMPDIR': str(out), 'NEXT_TELEMETRY_DISABLED': '1'})
        log, err = out / 'mock.ndjson', out / 'mock.err'
        with log.open('w') as stdout, err.open('w') as stderr:
            log.chmod(0o600)
            err.chmod(0o600)
            mock = subprocess.Popen(['postman', 'simulation', 'run', 'postman/simulations/paypal-native-callback-regression.sim.yaml', '--port', 'auto', '--no-history', '--output', 'ndjson'], cwd=snapshot, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        deadline = time.monotonic() + 60
        listening = None
        while time.monotonic() < deadline:
            listening = next((event for event in events(log) if event.get('event') == 'listening'), None)
            if listening:
                break
            if mock.poll() is not None:
                raise RuntimeError('Postman simulation exited before listening')
            time.sleep(0.2)
        if not listening:
            raise RuntimeError('Postman simulation did not start')
        port = int(listening['port'])
        guard = out / 'loopback-only.cjs'
        guard.write_text(GUARD)
        guard.chmod(0o600)
        driver_env = {**env, 'NODE_OPTIONS': f'--require={json.dumps(str(guard))}'}
        result = subprocess.run(['node', '--max-old-space-size=256', str(snapshot / 'tests/paypal-native-callback-simulation-driver.cjs'), str(snapshot), str(port)], cwd=snapshot, env=driver_env, capture_output=True, text=True, timeout=45)
        driver_log = out / 'driver.log'
        driver_log.write_text(result.stdout + result.stderr)
        driver_log.chmod(0o600)
        if result.returncode:
            raise RuntimeError('Fictional callback driver failed; inspect driver.log')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}/identity/_fixture/stats', timeout=5) as response:
            stats = json.load(response)
        observed = [event for event in events(log) if event.get('event') == 'request']
        if any(stats.get(key) != expected for key, expected in {'prepare': 14, 'token': 6, 'jwks': 6, 'userinfo': 6}.items()):
            raise RuntimeError('Fictional provider call counts did not match')
        if stats.get('tokenRejections'):
            raise RuntimeError('Fictional provider rejected a token request')
        if not observed or not all(event.get('routeKey') == 'identity' for event in observed):
            raise RuntimeError('Postman did not record the expected isolated route')
        write_json(out / 'fixture-result.json', {'driver_exit_code': result.returncode, 'fixture_counts': stats, 'postman_logged_requests': len(observed), 'all_logged_route_keys_identity': True})
        return 0
    finally:
        stop(mock)
        subprocess.run(['umount', str(state)], check=True, capture_output=True)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--inside':
        return inner(Path(sys.argv[2]))
    if len(sys.argv) != 1:
        raise RuntimeError('Unexpected arguments')
    for command in ('node', 'postman', 'unshare', 'mount', 'umount', 'ip'):
        if not shutil.which(command):
            raise RuntimeError(f'Missing required tool: {command}')
    checks = []
    output_root = Path('/home/protocol-x/Downloads')
    for _ in range(3):
        checks.append({'available_memory_mib': round(memory(), 1), 'free_disk_mib': round(disk(output_root), 1)})
        time.sleep(1)
    if any(item['available_memory_mib'] < 3481.6 or item['free_disk_mib'] < 3072 for item in checks):
        raise RuntimeError('Resource preflight failed; no simulation started')
    out = Path(tempfile.mkdtemp(prefix='paypal-native-callback-sim-', dir=output_root))
    snapshot = out / 'snapshot'
    snapshot.mkdir(mode=0o700)
    before = hashes(ROOT)
    for name in SOURCE:
        source = ROOT / name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError('Unexpected source path')
        target = snapshot / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source, target)
        target.chmod(0o600)
    if before != hashes(snapshot) or before != hashes(ROOT):
        raise RuntimeError('Source changed during snapshot')
    write_json(out / 'source-before.json', before)
    (snapshot / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    env = {key: os.environ[key] for key in ('HOME', 'PATH') if key in os.environ}
    env.update({'PARENT_NET': str(os.stat('/proc/self/ns/net').st_ino), 'PARENT_MNT': str(os.stat('/proc/self/ns/mnt').st_ino)})
    command = ['unshare', '-Urnm', sys.executable, '-u', str(Path(__file__).resolve()), '--inside', str(out)]
    write_json(out / 'command.json', {'command': command, 'network': 'private namespace; loopback only', 'credentials': 'fictional only'})
    print(f'Running fictional native callback simulation in {out}', flush=True)
    started = time.monotonic()
    peak = peak_count = 0
    stopped = None
    with (out / 'run.log').open('wb') as log:
        (out / 'run.log').chmod(0o600)
        child = subprocess.Popen(command, cwd=out, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while child.poll() is None:
                rss, count = tree(child.pid)
                peak, peak_count = max(peak, rss), max(peak_count, count)
                if count > PROCESS_LIMIT:
                    stopped = 'process limit'
                elif rss > LIMIT:
                    stopped = 'RSS limit'
                elif min(memory(), disk(out)) < FLOOR:
                    stopped = 'available resource floor'
                elif time.monotonic() - started > TIMEOUT:
                    stopped = 'wall timeout'
                if stopped:
                    stop(child)
                    break
                time.sleep(0.15)
        finally:
            if child.poll() is None:
                stop(child)
        code = child.wait()
    stable = before == hashes(ROOT) == hashes(snapshot)
    metrics = {'outcome': 'passed' if code == 0 and not stopped and stable else 'failed or guard stopped', 'exit_code': code, 'stopped_for': stopped, 'source_unchanged': stable, 'peak_tree_rss_mib': round(peak, 2), 'peak_processes': peak_count, 'rss_limit_mib': LIMIT, 'elapsed_seconds': round(time.monotonic() - started, 2), 'preflight': checks}
    write_json(out / 'metrics.json', metrics)
    print(json.dumps(metrics, indent=2), flush=True)
    return 0 if metrics['outcome'] == 'passed' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print('Simulation did not complete: ' + str(exc), file=sys.stderr)
        sys.exit(1)
