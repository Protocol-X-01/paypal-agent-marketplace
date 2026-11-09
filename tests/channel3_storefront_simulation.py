#!/usr/bin/env python3
"""Run copied Next routes with unchanged HTTPS through a loopback Postman proxy.

This is an isolated test harness, not a production build or deployment. It
copies a narrow set of application files and leaves the source tree untouched.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
SCRATCH_ROOT = ROOT.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'tests'))
import market_currency_simulation as isolation

SOURCES = (
    'package.json', 'package-lock.json', 'next.config.ts', 'next-env.d.ts', 'tsconfig.json',
    'src/lib/channel3.ts', 'src/lib/channel3-storefront.ts', 'src/lib/channel3-catalog.ts',
    'src/lib/channel3-rate-limit.ts', 'src/lib/mobile-web-cors.ts', 'src/lib/request-limits.ts',
    'src/app/api/marketplace/search/route.ts', 'src/app/api/marketplace/catalog/route.ts',
)
REQUESTS = (
    'Search live marketplace products and offers.request.yaml',
    'Browse curated audio product section.request.yaml',
    'Search products in the US storefront.request.yaml',
    'Browse the US curated audio section.request.yaml',
    'Reject unsupported search storefront.request.yaml',
    'Reject unsupported catalog storefront.request.yaml',
    'Reject oversized marketplace search body.request.yaml',
)
API_COLLECTION = Path('postman/collections/PayPal Market APIs/api')
MOCK_DIR = Path('postman/mocks/channel3-storefront-regression')
FIXTURE_FILES = (MOCK_DIR / 'config.yaml', MOCK_DIR / 'default.js',
                 *(API_COLLECTION / name for name in REQUESTS))
MEM_START_KIB = int(3.4 * 1024 * 1024)
MEM_STOP_KIB = int(1.5 * 1024 * 1024)
TREE_STOP_KIB = 1800 * 1024
FREE_DISK_BYTES = int(1.5 * 1024 * 1024 * 1024)
DISK_FILESYSTEMS = {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs'}

DRIVER = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

work = Path(sys.argv[1])
app = work / 'app'
collection = work / 'collection'

def request(base, path, body=None, headers=None):
    req = urllib.request.Request(base + path, data=body, headers=headers or {})
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=90)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response), response.headers

def check(label, ok):
    print(('PASS ' if ok else 'FAIL ') + label, flush=True)
    if not ok:
        raise RuntimeError(label)

with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
log = work / 'next.log'
process = None
try:
    with log.open('w') as output:
        process = subprocess.Popen(['node', './node_modules/next/dist/bin/next', 'dev', '--webpack',
                                    '--hostname', '127.0.0.1', '--port', str(port)],
                                   cwd=app, env=os.environ.copy(), stdout=output, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f'Next exited before readiness ({process.returncode})')
        if 'Ready in' in log.read_text(errors='replace'):
            break
        time.sleep(.2)
    else:
        raise RuntimeError('Next did not become ready')

    for name, path, body in (
        ('legacy search', '/api/marketplace/search', {'query':'headphones','limit':2}),
        ('legacy catalog', '/api/marketplace/catalog?section=audio', None),
    ):
        status, response, _ = request(base, path, json.dumps(body).encode() if body else None,
                                      {'Content-Type':'application/json'} if body else None)
        check(name + ' uses configured DE/GBP/de', status == 200 and response.get('storefront') == 'DE'
              and response.get('currency') == 'GBP' and response.get('products',[{}])[0].get('id') == 'fixture-DE-GBP-de')

    collection_env = os.environ.copy()
    for key in list(collection_env):
        if key.startswith('PKG_') or key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy',
                                               'all_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS'):
            collection_env.pop(key, None)
    collection_env['NODE_OPTIONS'] = '--max-old-space-size=384'
    run = subprocess.run(['postman', 'collection', 'run', str(collection), '--env-var', f'baseUrl={base}',
                          '--env-var', 'mockLocaleFixture=enabled', '--no-report-events'],
                         cwd=work, env=collection_env, text=True, capture_output=True, timeout=120)
    print(run.stdout, end='', flush=True)
    if run.stderr:
        print(run.stderr, end='', file=sys.stderr, flush=True)
    check('Postman collection', run.returncode == 0)

    status, response, _ = request(base, '/api/marketplace/search', b'{invalid', {'Content-Type':'application/json'})
    check('invalid search JSON rejected locally', status == 400 and isinstance(response.get('error'), str))
    status, response, _ = request(base, '/api/marketplace/catalog?section=audio&storefront=GB&storefront=US')
    check('duplicate storefront rejected locally', status == 400 and isinstance(response.get('error'), str))
    status, response, _ = request(base, '/api/marketplace/search', b'{"query":"headphones","storefront":"GB"}',
                                  {'Content-Type':'application/json','Origin':'https://untrusted.invalid'})
    check('untrusted origin rejected locally', status == 403 and isinstance(response.get('error'), str))

    status, response, _ = request(base, '/api/marketplace/search', b'{"query":"unmodeled product","storefront":"GB"}',
                                  {'Content-Type':'application/json'})
    check('synthetic search provider failure becomes generic 503', status == 503 and
          response.get('error') == 'The product catalog is temporarily unavailable. Please try again later.')
    status, response, _ = request(base, '/api/marketplace/catalog?section=travel&storefront=US')
    check('synthetic catalog provider failure becomes generic 503', status == 503 and
          response.get('error') == 'The curated catalog is temporarily unavailable. Please try again later.')
finally:
    if process and process.poll() is None:
        process.terminate()
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process and process.returncode not in (0, -15, None):
        print('Next exit:', process.returncode, file=sys.stderr, flush=True)
    if log.exists():
        text = log.read_text(errors='replace')
        if 'FAIL ' in text or 'Error:' in text:
            print('Next log tail:', text[-2500:], file=sys.stderr, flush=True)
'''


def hashes(root):
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in SOURCES}


def fixture_hashes():
    return {str(name): hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FIXTURE_FILES}


def available_kib():
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):
            return int(line.split()[1])
    raise RuntimeError('MemAvailable is unavailable')


def verify_disk_backed(path):
    output = subprocess.run(['findmnt', '--json', '--output', 'FSTYPE,SOURCE', '--target', str(path)],
                            check=True, capture_output=True, text=True).stdout
    entries = json.loads(output).get('filesystems', [])
    if len(entries) != 1:
        raise RuntimeError('Scratch mount could not be identified unambiguously')
    filesystem, source = entries[0].get('fstype'), entries[0].get('source', '').split('[', 1)[0]
    if filesystem not in DISK_FILESYSTEMS or not source.startswith('/dev/') or not stat.S_ISBLK(os.stat(source).st_mode):
        raise RuntimeError(f'Scratch filesystem {filesystem or "unknown"} is not a verified block-device mount')
    parents = subprocess.run(['lsblk', '--noheadings', '--inverse', '--raw', '--output', 'TYPE', source],
                             check=True, capture_output=True, text=True).stdout.split()
    if 'disk' not in parents or 'loop' in parents:
        raise RuntimeError('Scratch backing device does not resolve to a non-loop disk')
    return filesystem


def process_tree_usage(root_pid):
    output = subprocess.run(['ps', '-eo', 'pid=,ppid=,rss=,stat='], check=True, text=True, capture_output=True).stdout
    rows = [line.split() for line in output.splitlines()]
    processes = {int(pid): (int(parent), int(rss), state) for pid, parent, rss, state in rows}
    members = {root_pid} if root_pid in processes else set()
    while True:
        expanded = members | {pid for pid, (parent, _, _) in processes.items() if parent in members}
        if expanded == members:
            break
        members = expanded
    live = [pid for pid in members if not processes[pid][2].startswith('Z')]
    return len(live), sum(processes[pid][1] for pid in live), live


def drain_owned_workload(process):
    if process is None:
        return True
    for sig, duration in ((signal.SIGINT, 8), (signal.SIGTERM, 5), (signal.SIGKILL, 3)):
        process.poll()
        if process.returncode is not None:
            return True
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return True
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            process.poll()
            if process.returncode is not None:
                return True
            time.sleep(.2)
    return process.poll() is not None


def live_pid_namespace(namespace):
    live = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if os.readlink(entry / 'ns/pid') != namespace:
                continue
            state = (entry / 'stat').read_text().rsplit(')', 1)[1].split()[0]
            if state != 'Z':
                live.append(int(entry.name))
        except (OSError, IndexError):
            continue
    return live


def wait_pid_namespace_empty(namespace, seconds=10):
    if namespace is None:
        return False
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not live_pid_namespace(namespace):
            return True
        time.sleep(.2)
    return not live_pid_namespace(namespace)


def mounts_inside(path):
    prefix = str(path.resolve())
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        encoded = line.split()[4]
        target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match.group(1), 8)), encoded)
        if target == prefix or target.startswith(prefix + '/'):
            mounts.append(target)
    return mounts


class GuardedScratch:
    def __init__(self, parent):
        self.path = Path(tempfile.mkdtemp(prefix='paypal-channel3-next-sim-', dir=parent))
        self.safe_to_remove = True

    def __enter__(self):
        return str(self.path)

    def __exit__(self, exc_type, exc, traceback):
        remaining = mounts_inside(self.path)
        if not self.safe_to_remove or remaining:
            print(f'Retained isolated scratch without traversing it: {self.path}', file=sys.stderr, flush=True)
            if remaining:
                print('Mounts still present: ' + ', '.join(remaining), file=sys.stderr, flush=True)
            return False
        # No chmod or forced removal; rmtree does not follow directory symlinks.
        if not shutil.rmtree.avoids_symlink_attacks:
            print(f'Retained scratch because safe symlink handling is unavailable: {self.path}', file=sys.stderr, flush=True)
            return False
        shutil.rmtree(self.path)
        return False


def verify_proxy_log(text):
    events = []
    for line in text.splitlines():
        try: value = json.loads(line)
        except json.JSONDecodeError: continue
        if isinstance(value, dict) and 'destination' in value:
            events.append(value)
    expected = [('/v1/search', 200)] * 3 + [('/v1/browse', 200)] * 3 + [('/v1/search', 501), ('/v1/browse', 501)]
    got = [(event.get('path'), event.get('statusCode')) for event in events]
    return ('Passthrough tunnel error' not in text and len(events) == 8 and sorted(got) == sorted(expected) and
            all(event.get('host') == 'api.trychannel3.com' and event.get('destination') == 'channel3' for event in events))


def main():
    os.umask(0o077)
    isolation.__file__ = str(Path(__file__).resolve())
    isolation.enter_private_namespaces()
    for command in ('node', 'postman', 'unshare', 'mount', 'umount', 'ps', 'findmnt', 'lsblk'):
        if not shutil.which(command):
            raise RuntimeError(f'{command} is required')
    if not (ROOT / 'node_modules/next/dist/bin/next').is_file():
        raise RuntimeError('Installed Next dependencies are required')
    filesystem = verify_disk_backed(SCRATCH_ROOT)
    print(f'Using {filesystem} scratch storage in {SCRATCH_ROOT}', flush=True)
    before = hashes(ROOT)
    fixtures_before = fixture_hashes()
    runner_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    helper_hash = hashlib.sha256((ROOT / 'tests/market_currency_simulation.py').read_bytes()).hexdigest()
    scratch = GuardedScratch(SCRATCH_ROOT)
    with scratch as temporary:
        work = Path(temporary)
        app = work / 'app'
        app.mkdir()
        for name in SOURCES:
            target = app / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        if hashes(app) != before or hashes(ROOT) != before:
            raise RuntimeError('Application source changed while copying')
        shutil.copytree(ROOT / MOCK_DIR, work / 'mock')
        (work / 'proxy.sim.yaml').write_text('''simulation: Channel3 full Next proxy regression
version: 1
routing: path
mocks:
  - name: channel3-storefront-regression
    routeKey: channel3
    path: mock
    origin: https://api.trychannel3.com
''')
        collection = work / 'collection'
        (collection / '.resources').mkdir(parents=True)
        (collection / '.resources/definition.yaml').write_text('''$kind: collection
name: Local Channel3 storefront regression
variables:
  - key: baseUrl
    value: http://127.0.0.1:0
''')
        api = ROOT / API_COLLECTION
        for name in REQUESTS:
            shutil.copyfile(api / name, collection / name)
        for name in ('Search live marketplace products and offers', 'Browse curated audio product section'):
            shutil.copytree(api / '.resources' / f'{name}.resources', collection / '.resources' / f'{name}.resources')
        (work / 'driver.py').write_text(DRIVER)
        # Next dev checks npm dist-tags at startup. Deny that unrelated lookup
        # locally before it reaches the proxy; Channel3 fetch stays untouched.
        (work / 'guard.cjs').write_text(isolation.GUARD + r'''
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  try {
    if (target && new URL(target).hostname === 'registry.npmjs.org') {
      return Promise.reject(new Error('npm registry unavailable in offline simulation'));
    }
  } catch {}
  return originalFetch.call(this, input, init);
};
''')

        state = Path.home() / '.postman'
        if not state.is_dir() or state.is_symlink():
            raise RuntimeError('Ordinary Postman settings directory required for masking')
        private_state = work / 'postman-state'
        private_state.mkdir()
        cached = state / 'dataset-engine/extracted'
        if cached.is_dir():
            for version in cached.iterdir():
                if version.is_dir() and not version.is_symlink():
                    for name in ('postman-dataset-engine', 'jdbc-driver-host.jar', 'libxlite.so', 'xsv0.so'):
                        source = version / name
                        if source.is_file() and not source.is_symlink():
                            target = private_state / 'dataset-engine/extracted' / version.name / name
                            target.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(source, target)
        deps = app / 'node_modules'
        deps.mkdir()
        subprocess.run(['mount', '--make-rprivate', '/'], check=True, capture_output=True)
        scratch.safe_to_remove = False
        subprocess.run(['mount', '--bind', str(private_state), str(state)], check=True, capture_output=True)
        mounted_deps = False
        child = None
        cleanup_errors = []
        result_code = 1
        log_path = None
        owned_namespace = []
        try:
            subprocess.run(['mount', '--bind', str(ROOT / 'node_modules'), str(deps)], check=True, capture_output=True)
            mounted_deps = True
            subprocess.run(['mount', '-o', 'remount,bind,ro', str(deps)], check=True, capture_output=True)
            samples = []
            for _ in range(3):
                samples.append(available_kib())
                time.sleep(1)
            if min(samples) < MEM_START_KIB:
                raise RuntimeError(f'Next withheld: available-memory samples below 3.4 GiB ({min(samples)} KiB minimum)')
            if shutil.disk_usage(SCRATCH_ROOT).free < FREE_DISK_BYTES:
                raise RuntimeError('Next withheld: free disk below 1.5 GiB')
            if hashes(ROOT) != before:
                raise RuntimeError('Application source changed before Next launch')
            if fixture_hashes() != fixtures_before:
                raise RuntimeError('Mock or collection changed before Next launch')
            immediate = available_kib()
            if immediate < MEM_START_KIB:
                raise RuntimeError(f'Next withheld: available memory fell below 3.4 GiB before launch ({immediate} KiB)')
            env = {key: os.environ[key] for key in ('HOME', 'PATH') if key in os.environ}
            env.update({'TMPDIR': str(work), 'LANG': 'C.UTF-8', 'NO_PROXY':'127.0.0.1,localhost',
                        'NODE_USE_ENV_PROXY':'1', 'NODE_OPTIONS':f'--max-old-space-size=512 --require={json.dumps(str(work / "guard.cjs"))}',
                        'NEXT_TELEMETRY_DISABLED':'1', 'NEXT_IGNORE_INCORRECT_LOCKFILE':'1', 'CHANNEL3_API_KEY':'simulation-only',
                        'CHANNEL3_COLLECTION_ID':'fixture-collection',
                        'CIRCLE_NODE_TOTAL':'2', 'RAYON_NUM_THREADS':'1', 'UV_THREADPOOL_SIZE':'2',
                        'CHANNEL3_COUNTRY':'DE', 'CHANNEL3_CURRENCY':'GBP', 'CHANNEL3_LANGUAGE':'de'})
            log = tempfile.NamedTemporaryFile(prefix='paypal-channel3-next-proxy-', suffix='.log', dir=SCRATCH_ROOT, delete=False)
            log_path = Path(log.name)
            log.write(('SOURCE_SHA256 ' + json.dumps(before, sort_keys=True) + '\n').encode())
            log.write(('FIXTURE_SHA256 ' + json.dumps(fixtures_before, sort_keys=True) + '\n').encode())
            log.write((f'RUNNER_SHA256 {runner_hash}\nISOLATION_HELPER_SHA256 {helper_hash}\n').encode())
            log.write(('NODE_VERSION ' + subprocess.run(['node', '--version'], check=True, capture_output=True, text=True).stdout.strip() + '\n').encode())
            log.write(b'TEST_LIMITS next_node_heap_mib=512 collection_node_heap_mib=384 circle_cpus=2 rayon_threads=1 uv_threads=2 tree_rss_mib=1800\n')
            log.flush()
            lift = f'{shlex.quote(sys.executable)} {shlex.quote(str(work / "driver.py"))} {shlex.quote(str(work))}'
            print(f'Next source copied unchanged; available-memory minimum: {min(samples)} KiB', flush=True)
            print(f'Simulation transcript: {log_path}', flush=True)
            child = subprocess.Popen(['unshare', '--mount', '--pid', '--fork', '--kill-child', '--mount-proc',
                                      'postman', 'simulation', 'run', 'proxy.sim.yaml', '--proxy', '--proxy-port', 'auto',
                                      '--no-history', '--log-format', 'json', '--lift', lift],
                                     cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            started = time.monotonic()
            stop = threading.Event()
            reason = []
            observed = {'peak_rss_kib': 0, 'peak_processes': 0, 'samples': 0}
            parent_pid_namespace = os.readlink('/proc/self/ns/pid')
            def monitor():
                while not stop.wait(1):
                    try:
                        count, rss, members = process_tree_usage(child.pid)
                        observed['peak_rss_kib'] = max(observed['peak_rss_kib'], rss)
                        observed['peak_processes'] = max(observed['peak_processes'], count)
                        observed['samples'] += 1
                        if not owned_namespace:
                            for pid in members:
                                try:
                                    candidate = os.readlink(f'/proc/{pid}/ns/pid')
                                    if candidate != parent_pid_namespace:
                                        owned_namespace.append(candidate)
                                        break
                                except OSError:
                                    continue
                        low_memory = available_kib() < MEM_STOP_KIB
                        low_disk = shutil.disk_usage(SCRATCH_ROOT).free < FREE_DISK_BYTES
                        if low_memory or low_disk or rss > TREE_STOP_KIB or count > 12 or time.monotonic() - started > 600:
                            reason.append(f'resource guard: memory={low_memory}, disk={low_disk}, tree_rss_kib={rss}, processes={count}')
                            drain_owned_workload(child)
                            return
                    except (OSError, ValueError, subprocess.CalledProcessError):
                        reason.append('resource guard could not sample the process tree')
                        drain_owned_workload(child)
                        return
            watcher = threading.Thread(target=monitor, daemon=True)
            watcher.start()
            try:
                child.wait(timeout=620)
            except subprocess.TimeoutExpired:
                reason.append('simulation exceeded its maximum duration')
                drain_owned_workload(child)
            finally:
                stop.set()
                watcher.join(timeout=20)
                log.close()
            drained = drain_owned_workload(child)
            namespace_empty = wait_pid_namespace_empty(owned_namespace[0] if owned_namespace else None)
            if not drained or not namespace_empty:
                reason.append('owned PID namespace did not drain or could not be verified')
            output = log_path.read_text(errors='replace')
            print(output, end='', flush=True)
            if reason:
                print('FAIL', '; '.join(reason), flush=True)
            proxy_ok = verify_proxy_log(output)
            proxy_summary = ('PASS' if proxy_ok else 'FAIL') + ' proxy recorded exactly six 200 and two modeled 501 Channel3 calls, with no passthrough'
            current = hashes(ROOT) == before
            source_summary = ('PASS' if current else 'FAIL') + ' selected main application sources remained unchanged'
            # Next may regenerate next-env.d.ts in the disposable project.
            stable_inputs = [name for name in SOURCES if name != 'next-env.d.ts']
            snapshot_stable = all(hashlib.sha256((app / name).read_bytes()).hexdigest() == before[name] for name in stable_inputs)
            snapshot_summary = ('PASS' if snapshot_stable else 'FAIL') + ' copied application sources and configuration remained unchanged'
            fixture_stable = fixture_hashes() == fixtures_before
            fixture_stable = fixture_stable and all(
                hashlib.sha256((work / 'mock' / name.name).read_bytes()).hexdigest() == fixtures_before[str(name)]
                for name in (MOCK_DIR / 'config.yaml', MOCK_DIR / 'default.js')
            ) and all(
                hashlib.sha256((collection / name).read_bytes()).hexdigest() == fixtures_before[str(API_COLLECTION / name)]
                for name in REQUESTS
            )
            fixture_stable = fixture_stable and hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == runner_hash
            fixture_stable = fixture_stable and hashlib.sha256((ROOT / 'tests/market_currency_simulation.py').read_bytes()).hexdigest() == helper_hash
            fixture_summary = ('PASS' if fixture_stable else 'FAIL') + ' mock, collection, runner and isolation helper remained unchanged'
            guard_summary = f"GUARD observed {observed['samples']} samples; peak tree RSS {observed['peak_rss_kib']} KiB; peak processes {observed['peak_processes']}"
            summary = '\n'.join((proxy_summary, source_summary, snapshot_summary, fixture_summary, guard_summary))
            print(summary, flush=True)
            with log_path.open('a') as evidence:
                evidence.write('\n' + summary + '\n')
            result_code = 0 if child.returncode == 0 and proxy_ok and current and snapshot_stable and fixture_stable and not reason else 1
        finally:
            cleanup_lines = []
            try:
                group_stopped = drain_owned_workload(child)
                namespace_empty = child is None or wait_pid_namespace_empty(owned_namespace[0] if owned_namespace else None)
            except (OSError, ValueError, subprocess.CalledProcessError) as error:
                group_stopped = False
                namespace_empty = False
                cleanup_errors.append(f'Could not verify owned process group: {error}')
            if not group_stopped or not namespace_empty:
                cleanup_errors.append('Owned PID namespace is still active or could not be verified')
            else:
                cleanup_lines.append('PASS owned PID namespace drained')
                for label, target, mounted in (('dependency bind', deps, mounted_deps), ('Postman settings bind', state, True)):
                    if not mounted:
                        continue
                    result = subprocess.run(['umount', str(target)], capture_output=True, text=True)
                    if result.returncode:
                        cleanup_errors.append(f'{label} unmount failed ({result.returncode}): {result.stderr.strip()}')
                    else:
                        cleanup_lines.append(f'PASS {label} unmounted')
            remaining = mounts_inside(work)
            if remaining:
                cleanup_errors.append('Mounts remain inside scratch: ' + ', '.join(remaining))
            cleanup_lines.extend('FAIL cleanup: ' + error for error in cleanup_errors)
            for line in cleanup_lines:
                print(line, file=sys.stderr if line.startswith('FAIL') else sys.stdout, flush=True)
            if log_path is not None:
                with log_path.open('a') as evidence:
                    evidence.write('\n' + '\n'.join(cleanup_lines) + '\n')
            scratch.safe_to_remove = not cleanup_errors
        if cleanup_errors:
            raise RuntimeError('Scratch retained because cleanup was incomplete')
        return result_code


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Next simulation could not run: {error}', file=sys.stderr)
        sys.exit(1)
