# Local PayPal Business first-page inspection

Run `python3 tests/paypal-business-first-page-simulation.py` from the repository
root. It requires Linux user, network and mount namespaces; `unshare`, `mount`,
`umount`, `ip`, Python 3, Node, installed repository dependencies, and Postman
CLI with its cached dataset runtime. It uses a private loopback-only network,
fresh temporary Postman settings, no project environment file and only
fictional credentials and response fields. The adapter source is transpiled
and run for real; the test supplies a transport that maps its sandbox URL to
the local mock. The collection is run against that same mock.

The test covers a first-page response containing fictional identifying fields
and duplicate IDs, permission denial, malformed and oversized responses,
timeout, a redirect, and a missing transaction list. It checks that outputs
stay incomplete and contain no synthetic private markers, the redirect target
is not reached, and the mock received the intended requests. The mock is
locally authored from the documented API subset; no owner mock was searched
because Postman is signed out. A pass does not establish real PayPal behavior,
merchant access, page identity or stability, payment direction, financial
totals, deployment, or browser/device behavior. No real request is made to
PayPal.
