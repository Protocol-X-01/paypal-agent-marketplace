# Local currency regression simulation

From the repository root, run:

```sh
python3 tests/market_currency_simulation.py
```

This requires Linux with user, mount and network namespaces enabled; `unshare`,
`mount`, `umount`, and `ip`; Python 3; Node; the repository's installed Node
dependencies; and Postman CLI 1.70 or newer with its dataset-engine runtime
already cached in the usual `.postman` state directory. The runner leaves `HOME`
unchanged and uses a private mount namespace to mask that state directory with a
temporary directory containing only the cached runtime files.
The private network namespace has only loopback access, and `--no-history` keeps
the simulation local. Namespace setup fails closed if it is unavailable.

The runner starts a Postman simulation and an isolated Next.js server on
automatically selected loopback ports. It copies only an explicit list of source
and fixture files, links the installed `node_modules`, and supplies the dummy
Demo key `simulation-only`. It copies only Postman's installed dataset-engine
runtime files from its local cache, never its settings. It does not copy the
project's `.env`, `.git`, or user data. The temporary processes, files, and mount
are cleaned up on completion.

The runner replaces the provider base URL **only in the temporary source copy**
with the local simulation address and checks that an application-side network
guard rejects non-loopback TCP connections. It verifies the mock's request log as
well as the responses. If the production provider base declaration changes, the
runner stops so the snapshot setup can be reviewed. The manifest is intentionally
for Postman's one-port mode; it does not declare a proxy origin.

The checks cover synthetic GBP quotes and history, an empty provider list, a
provider failure, two rate limits, the 7-day sparkline fallback, unsupported
currencies, invalid negative history values, a fractional history timestamp,
and the legacy USD route. All prices and errors in the fixture are
invented. A pass demonstrates the application's behavior under those conditions;
it does not validate live CoinGecko prices, authentication, TLS, or provider
availability. See the neighboring context file for evidence and unresolved
provider assumptions. No mock or result is published by this command.
