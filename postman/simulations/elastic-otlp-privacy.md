# Local Elastic OTLP privacy simulation

From the repository root, with the project dependencies installed:

```sh
python3 tests/elastic-otlp-simulation.py
```

This requires Linux user, mount and network namespaces; `unshare`, `mount`,
`umount`, `ip`; Python 3; Node; and Postman CLI 1.70 or newer. The runner
reuses the reviewed namespace helper in `tests/market_currency_simulation.py`.
It leaves `HOME` unchanged, masks Postman's settings in a private mount
namespace, and brings up only loopback in a private network namespace. Child
processes inherit a minimal environment; `.env`, customer data, real API
keys, and Postman settings are not copied. A Node guard also blocks non-loopback
TCP connections. The local mock and temporary files are removed after the run.

The test constructs real OpenTelemetry SDK spans containing a fictional
private marker in their resource, scope, name, attributes, trace state,
events, links and status. It runs the exact current
`PrivacyFilterSpanProcessor` around real `@vercel/otel`, official
`@opentelemetry/exporter-trace-otlp-proto`, and the official exporter inside
the application's `PrivacySafeSpanExporter`. The Postman receiver decodes
their uncompressed protobuf bodies, verifies selected route/service metadata
and empty events/links, and checks that the marker is absent from every body.
It returns an empty success protobuf or a synthetic HTTP 400, 503, or 307; a
separate closed loopback port exercises network failure. The error responses
carry the fictional marker in a protobuf `google.rpc.Status` message. The
test observes numeric HTTP statuses, aggregate fixture counters and exporter
result properties, without printing request bodies, errors or credentials.

The wrapper check observes the same official delegate error before and after
redaction, captures OpenTelemetry warning/error output, and injects synthetic
diagnostic and lifecycle failures. The redirect check verifies that this Node
exporter reports 307 as a failure and does not reach the mock's redirect
target. As a positive control for `withoutOtlpEnvironmentHeaders`, the test
puts the fictional marker into both inherited OTLP header settings while
constructing each exporter: the raw official exporter sends those synthetic
headers, whereas the production helper prevents them from reaching the mock
and restores the settings afterwards. Only header-presence counters are kept.

The Postman assertion checks synthetic receiver counters. Request logs are
examined to show that the actual exporters reached the mock; they are not kept
after the run. A missing Postman authorization warning is expected because
the settings directory is masked. The owner's published mock was not searched
because Postman is in a temporary local session; this fixture implements only
the stated OTLP paths and returns 501 for others.

In the observed run, `@vercel/otel` 2.2.1 reported success for HTTP 400 and
503, while the official 0.223.0 exporter reported failure and retried 503.
The raw official exporter's HTTP 400 error contained the fictional response
marker; the wrapped exporter returned a sanitized error for the same response.
The diagnostic logger withheld the marker in the exercised calls. These are
local, synthetic observations, not proof that every possible diagnostic or
header source is safe. The comparison does not execute `instrumentation.ts`
registration, Render, real Elastic behavior, TLS, authentication, all possible
spans, or delivery guarantees. No Postman artifact is published by this command.
