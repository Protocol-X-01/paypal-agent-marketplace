#!/usr/bin/env python3
"""Exercise the actual Channel3 adapter/routes against a loopback-only TLS stand-in."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
import market_currency_simulation as isolation

ROOT = Path(__file__).resolve().parents[1]
SOURCES = (
    'src/lib/channel3.ts', 'src/lib/channel3-storefront.ts',
    'src/lib/channel3-catalog.ts', 'src/lib/mobile-web-cors.ts',
    'src/app/api/marketplace/search/route.ts', 'src/app/api/marketplace/catalog/route.ts',
    'tests/channel3-response-https-driver.cjs',
)


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}


def main():
    os.umask(0o077)
    isolation.__file__ = str(Path(__file__).resolve())
    isolation.enter_private_namespaces()
    if not all(shutil.which(name) for name in ('node', 'openssl')):
        raise RuntimeError('Node and OpenSSL are required for the local TLS simulation')
    before = fingerprints()
    with tempfile.TemporaryDirectory(prefix='paypal-channel3-body-https-') as temporary:
        work = Path(temporary)
        key, cert = work / 'key.pem', work / 'cert.pem'
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
            '-keyout', str(key), '-out', str(cert), '-nodes', '-days', '1',
            '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
        ], check=True, capture_output=True, timeout=15)
        guard = work / 'network-guard.cjs'
        guard.write_text(isolation.GUARD, encoding='utf8')
        clean_env = {
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
            'NODE_EXTRA_CA_CERTS': str(cert),
            'NODE_OPTIONS': f'--require={guard}',
            'LANG': 'C.UTF-8',
            'NO_PROXY': '*',
        }
        result = subprocess.run([
            'node', '--max-old-space-size=192', str(ROOT / 'tests/channel3-response-https-driver.cjs'), str(key), str(cert),
        ], cwd=ROOT, env=clean_env, text=True, capture_output=True, timeout=30)
        print(result.stdout, end='', flush=True)
        if result.returncode:
            print(result.stderr, end='', file=sys.stderr, flush=True)
            return result.returncode
    stable = before == fingerprints()
    print(f'{"PASS" if stable else "FAIL"} draft source remained unchanged during the simulation', flush=True)
    return 0 if stable else 1


if __name__ == '__main__':
    sys.exit(main())
