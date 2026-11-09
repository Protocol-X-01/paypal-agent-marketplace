# Local Channel3 storefront regression

From the repository root, run:

```sh
python3 tests/channel3_storefront_simulation.py
```

This requires Linux user, mount and network namespaces; `unshare`, `mount`,
`umount`, `ip`, `findmnt`, `lsblk`, and `ps`; Python 3; Node 24 with environment-proxy
support; installed repository dependencies; and Postman CLI 1.70 or newer with
its normal `.postman` directory and cached dataset-engine runtime. The runner
uses the repository's parent directory for scratch and the saved transcript,
after `findmnt` and `lsblk` confirm a supported filesystem backed by a non-loop
block device. It leaves `HOME`
unchanged, masks Postman settings in a private mount namespace, uses a
loopback-only network, and passes `--no-history` and `--no-report-events`.
A warning about missing Postman authorization is expected in the isolated
settings directory.

The runner copies the selected route graph and configuration into a disposable
project, mounts installed dependencies read-only, and runs Next dev/webpack.
It copies no project `.env`, `.git`, user data or Postman settings. The copied
application source and HTTPS guard remain unchanged. A test-only Postman proxy
intercepts the default Channel3 HTTPS hostname using a temporary CA and the
fictional key `simulation-only`. A preload rejects Next dev's unrelated npm
version lookup and the test sets `NEXT_IGNORE_INCORRECT_LOCKFILE`; neither
changes application files or real dependency installations.

Before Next starts, the runner requires three available-memory samples of at
least 3.4 GiB and checks again immediately before launch. The workload uses a
private PID namespace; a best-effort guard monitors its full descendant tree
and stops it if memory, process count, disk or duration limits are exceeded.
The test sets smaller Node heaps and conservative thread defaults; those are
not hard caps on total process memory. It prints the transcript path and records
source fingerprints; it checks selected working-tree and copied source files
again at the end. A guard stop is a test-resource result, not a source-build
failure. Mounts are normally unmounted after the owned namespace drains; scratch
is retained without traversal if cleanup cannot be verified.

The checks cover GB/GBP and US/USD search and browse, unsupported storefronts,
an oversized search body, malformed JSON, duplicate storefront, an untrusted
origin, synthetic provider failures and omitted-storefront behavior with a
deliberately mixed DE/GBP/de legacy configuration. Fixture product identifiers
encode the received provider configuration; the proxy log verifies the expected
mock calls and no passthrough. A pass establishes local development-runtime
behavior against synthetic responses, not a production build, deployed site,
browser or device rendering, live prices, authentication or checkout. Nothing
is published.

## Lower-memory route bridge

From the repository root, an additional, smaller check is available:

```sh
python3 tests/channel3_storefront_bridge_simulation.py
```

It calls the actual search and curated-catalog route functions for GB/GBP and
US/USD. A fictional collection-scoped search also returns the target on page
two and rejects reuse of its continuation in another storefront. A maintained
Postman search request runs against the actual route through a loopback HTTP
bridge, with the Channel3 call handled by the stand-in. The stand-in receives
five search and two browse requests. It uses the same private Linux
network and mount namespaces, a dummy key, and a masked Postman state directory;
it does not copy project environment files or credentials. The adapter's HTTPS
guard is changed only in the in-memory test copy to allow loopback HTTP.

This bridge transpiles the routes and calls them in one Node process using
`NextRequest`. It does **not** start Next.js, exercise its HTTP server or routing,
or replace the fuller simulation above. Both checks use synthetic provider data;
neither establishes current live prices or product availability.

## Earlier source-matched Next HTTPS-proxy prototype

On 2026-11-06, the separate local runner
`/home/protocol-x/Downloads/paypal-channel3-next-proxy-simulation.py` exercised
the copied marketplace route graph in Next dev/webpack. It passed seven Postman
requests/assertions for GB/GBP and US/USD search/catalog, unsupported regions
and oversized search; direct requests also checked configured legacy defaults,
malformed JSON, duplicate regions, an untrusted origin and two modeled provider
failures. The proxy recorded eight mock calls, including the two modeled 501
responses, and zero passthrough. The exact output and source hashes are in
`/home/protocol-x/Downloads/paypal-channel3-next-proxy-_r9nik0h.log`.

That prototype remains available separately for the historical evidence. The
repository command at the top is the maintained, repo-relative runner.

The prototype used process-group-only memory accounting, which missed detached
workers; it does not establish compliance with the later full-tree memory guard.
The PID-contained repository run saved at
`/home/protocol-x/Downloads/paypal-channel3-next-proxy-tm73pvqo.log` stopped
before its collection finished when observed tree RSS reached 2,232,256 KiB,
above the 1,800 MiB limit. Its owned namespace drained, both binds unmounted
normally, and scratch was removed. Its partial HTTP results do not replace the
full prototype pass.

A further run with 512 MiB Next and 384 MiB collection Node heap settings and
conservative thread defaults also stopped before the collection completed:
the guard observed a 2,079,604 KiB tree-RSS sample, above the unchanged limit.
It recorded six samples, preserved source and fixture fingerprints, drained its
PID namespace, unmounted both binds normally and removed its scratch directory.
See `/home/protocol-x/Downloads/paypal-channel3-next-proxy-0klonguu.log` for the
exact output. Memory is sampled once per second and RSS can double-count shared
pages; these observations are not a hard process-memory cap.
