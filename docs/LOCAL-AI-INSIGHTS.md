# Local AI insights demonstration

The customer market endpoint and separate management-concept endpoint call OpenAI's Responses API only after explicit local opt-in. The customer endpoint derives its input from the selected public CoinGecko OHLC candles; it does not accept holdings, accounts, private data or free-form prompts. The management endpoint derives its input solely from the management app's invented aggregate fixture; it has no staff identity or live customer-reporting source. Both return model-generated qualitative text alongside independently calculated source facts and a fixed disclaimer. Model text can still be inaccurate.

## Local runtime prerequisites

Supply these values to each local process through its approved server-side runtime configuration; do not place keys in source or client code. The customer and management processes must use the **same** owner-only state directory.

| Variable | Local demonstration value or purpose |
| --- | --- |
| `AI_INSIGHTS_LOCAL_DEMO` | Exactly `true`; otherwise disabled. |
| `AI_INSIGHTS_LOCAL_ORIGIN` | Exact HTTP loopback origin for that app, for example `http://localhost:3000` or `http://127.0.0.1:3002`. |
| `AI_INSIGHTS_SHARED_STATE_DIR` | Same existing absolute directory for both processes, owned by the process user with permissions `0700`; no symlink. |
| `OPENAI_API_KEY` | OpenAI key in the server process only. |
| `COINGECKO_DEMO_API_KEY` | Existing CoinGecko Demo key in the customer market process only; the fictional management report does not use it. |
| `AI_INSIGHTS_MODEL` | Optional compatible Responses model; defaults to `gpt-6-luna`. |

The process must run with `NODE_ENV=development`, bind its listener to loopback, and have **no external reverse proxy or tunnel**. The code also rejects common hosted-environment markers and requires matching Origin and Host. Those HTTP headers are not authentication and do not prove the network boundary. Verify listener and proxy isolation before enabling this demonstration; do not enable these routes on a hosted service. A hosted version needs a separately reviewed authenticated, authorized and abuse-controlled design.

Each accepted attempt is recorded before source retrieval, even if it fails. A shared filesystem lock allows one in-flight attempt across the two local processes; the ledger permits at most two attempts in a rolling minute and ten in a rolling 24 hours. The limits cap attempts and output size, not a guaranteed monetary amount; provider pricing and a configured model can change. Pointing the processes at different directories creates separate budgets and is not the intended setup. A process crash can leave `in-flight.lock`; this deliberately fails closed. The local operator should verify no insight request remains active before manually removing an abandoned lock. Protect the directory and ledger from untrusted modification.

## Source and output boundaries

- Market selection is limited to the seven tracked assets, supported display currencies and existing day ranges. The source fields identify CoinGecko, retrieval time, actual first/last candle close timestamps, candle interval, closing prices and candle high/low extrema. Candles with a close after retrieval time are excluded. This OHLC series may differ from the line chart, and it is not a PayPal execution quote.
- Fictional report selection is limited to the fixture's 7/30-day periods and fixed account and market filters. Its source explicitly says `Fictional local fixture`, with exact period boundaries and fixture timestamp. Nothing in the route connects a real report, identity or payment system.
- OpenAI requests use `store: false`, no tools, strict structured output, a bounded response and deadline, and no automatic retry. The application validates the returned shape and rejects incomplete responses, refusals, tool calls, excessive text, digits, currency symbols, angle-bracket markup and URLs. Exact numbers are delivered in the server-computed source rather than model prose. This is not a semantic fact-check: qualitative output or numbers written as words may still be wrong.
- Requests are limited to 4 KiB; provider responses to 256 KiB; OpenAI output to 512 tokens and a 15-second provider deadline. Errors are generic and do not expose provider bodies or credentials. A failure or timeout still consumes the reserved local attempt.

The local Postman collections default to unreachable `127.0.0.1:9` and contain foreign-origin rejection checks. They do not call OpenAI unless deliberately modified. No key, service configuration, public deployment or live provider acceptance is established by these artifacts. Official references: [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), and [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
