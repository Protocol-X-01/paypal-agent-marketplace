# Local provider redirect regression

Run from the repository root after installing project dependencies:

```sh
python3 tests/provider-redirect-simulation.py
```

This Linux-only test needs user, mount and network namespaces; `unshare`,
`mount`, `umount`, `ip`, Python 3, Node, OpenSSL and Postman CLI 1.70 or newer.
It reuses the repository's namespace helper, starts only loopback networking,
generates a short-lived local TLS certificate, uses a temporary Postman home,
and supplies only fictional credentials and webhook data. It does not load
`.env`, call a live provider or publish artifacts. The provider owners' mocks
were not searched because this work was restricted to local operations.

The runner executes the actual provider modules through real Node HTTPS and
the Postman stand-in. Search, browse, quotes, chart, OAuth token and webhook
verification each receive a normal response, a same-origin 307 and a
cross-origin 307. The collection checks aggregate upstream counts and the
same-origin target; the driver checks that the separate cross-origin target
received no request. The mock stores only aggregate counters; the temporary
simulation log is used for request and status counts and is deleted afterwards.
The runner never prints bodies, errors or credentials.

The test substitutes only the fixed CoinGecko and PayPal base URLs in an
in-memory source copy so they address the local TLS stand-in; Channel3 uses
its existing configurable base URL. The `next/cache` helper is a no-op in
this direct module test, so this does not execute Next.js's caching or fetch
instrumentation. It covers synthetic 307 responses, not every 3xx code or
real provider behavior. A real provider that requires a redirect will now
receive the application's existing unavailable response until its endpoint
configuration is reviewed. A missing Postman authorization warning is
expected in the temporary home.
