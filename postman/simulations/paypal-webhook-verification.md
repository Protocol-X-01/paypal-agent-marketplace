# Local PayPal webhook verification regression

From the repository root, run:

```sh
python3 tests/paypal-webhook-simulation.py
```

This requires Linux user, mount, and network namespaces; `unshare`, `mount`,
`umount`, `ip`, Python 3, Node, the installed repository dependencies, and
Postman CLI 1.70 or later with its cached dataset-engine runtime. It runs in
a loopback-only network namespace with fresh temporary Postman settings and
uses `--no-history` and `--no-report-events`.

Only the explicit receiver, adapter, driver, collection, and mock files are
copied to a temporary directory. The project `.env`, `.git`, and user data are
not copied. The driver loads the actual TypeScript receiver and adapter, using
the repository's TypeScript compiler, and changes only the adapter's PayPal
base URLs in memory to the local mock. A small HTTP bridge supplies actual
incoming requests to the receiver. The provider mock checks the fictional
OAuth request, transmission headers, and exact embedded event bytes before
returning a modeled verification response.

The collection checks a verified fictional event, rejected signature, provider
failure, verification timeout, malformed bodies and headers, and content-type
rejection. A pass covers the local code against this stand-in; it does not
verify real signatures, PayPal authentication, a deployed webhook, TLS,
network behavior, or payments. It cannot prove that a real event will pass.
Nothing is published or sent to PayPal. A signed sandbox delivery using the
registered webhook and separately authorized sandbox activity is still needed.
