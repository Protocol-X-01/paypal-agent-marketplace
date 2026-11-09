# Zapier MCP readiness — refreshed 9 November 2026

The requested onboarding walkthrough has been completed read-only. The current tool inventory was refreshed on 6 November: Google Calendar has one connected default account and 11 enabled actions; GitHub has one connected default account and 26 enabled actions. Account identifiers and private calendar contents are deliberately omitted.

## Available now

| Connected app | Enabled capabilities | Useful project application |
| --- | --- | --- |
| Google Calendar | Find calendars/events, retrieve event details, inspect calendar information and busy periods; event-related read triggers | An explicitly requested agenda or availability rundown |
| GitHub | Find repository, branch, issue, pull request and organization information; retrieve files; repository activity read triggers | An explicitly requested project or submission-readiness rundown |

The enabled actions are reads, searches and read triggers. A trigger in the inventory does not mean a background automation has been scheduled. No calendar edit, subscription action, payment, external message or saved reusable Zapier workflow was created in this pass.

## Evidence and limits

Earlier authorized onboarding reads succeeded for the connected calendar list and the PayPal marketplace repository. The current refresh inspected enabled actions only; it did not read private events or claim present availability. Connector access belongs to the connected operator account. It does not establish customer-by-customer authentication or consent inside PayPal Markets.

## Deferred customer-agent features

The user deferred agent-created calendar events, subscription handling and AI payments until later in the week. Those flows still need explicit customer identity and consent, a concrete preview of each intended action, narrowly scoped connected accounts, safe retry/idempotency behavior, and an action history. Payments also need their own provider and authorization contract; Google Calendar/GitHub access supplies none of it.

A reusable rundown skill can be saved after its name and exact steps are confirmed, as required by Zapier's skill-creation tool. No new connector configuration or outbound action is implied by this report.

## Live onboarding rundown — 7 November 2026

The current Zapier skill list includes `zapier:onboarding`; its instructions were loaded and followed. A fresh action inventory still shows one Google Calendar connection (11 actions) and one GitHub connection (26 actions). For a read-only project pulse, the primary Google Calendar was queried for events overlapping the coming seven days, and GitHub's repository lookup was run for `Protocol-X-01/paypal-agent-marketplace`. The calendar query returned four events; only the three hackathon-related items were surfaced in chat. Their titles and the remaining personal calendar entry are not copied into this project file. The GitHub response confirms the repository is private, uses `main`, has no open issues, and was last pushed on 6 November at 20:30 UTC.

No writes, trigger polling, scheduled automation, new app connection or external message were made. No reusable Zapier skill was saved; that requires the user to confirm its exact name and steps. The calendar is connected through the user's personal Google account, while GitHub is connected through `Protocol-X-01`; neither connection supplies customer-specific consent inside PayPal Markets.

## Saved PayPal Project Pulse skill — 7 November 2026

The earlier statement that no reusable skill was saved is superseded. After the user confirmed the name and exact steps, Zapier saved `PayPal Project Pulse`. It resolves the currently connected account's primary Calendar at runtime, reads the next seven days and filters for PayPal project/hackathon items, then reads the fixed private PayPal repository's metadata and default-branch commit. It returns a concise combined report, omits unrelated personal event details, is read-only, and is not scheduled. The saved skill contains workflow instructions only; no sampled event titles were copied into it.

## Fresh read-only run — 7 November 2026, 06:37 UTC

The current skill list still contains `zapier:onboarding` and the saved `PayPal Project Pulse`. The enabled inventory remains Google Calendar (11 actions: 6 read/trigger and 5 search) and GitHub (26 actions: 18 read/trigger and 8 search); no write actions are enabled. The primary-calendar lookup returned one PayPal-related item in the next seven days. Its title and time stay in the conversation rather than this repository file; unrelated personal events were not reported.

GitHub lookup confirmed that `Protocol-X-01/paypal-agent-marketplace` remains private, its default branch is `main` at `c43558a0b32fa4b7e5f3df58fc11bfcb50e2569b`, the repository metadata's last-push time is `2026-11-07T06:14:51Z`, and its open-issue count field is `1` (GitHub may include pull requests in that field). No calendar or GitHub writes were run, and the saved skill remains unscheduled.

## Fresh read-only onboarding run — 7 November 2026, 14:49 UTC

Loaded and followed the current `zapier:onboarding` instructions, then ran the saved `PayPal Project Pulse` flow. The primary calendar query covered the current time through 14 November in Europe/London; three hackathon-related entries were surfaced in chat and unrelated personal event details were omitted. The query used the primary calendar on the connected personal Google account; GitHub used `Protocol-X-01`.

GitHub again confirmed the repository is private, with default branch `main` at `2f7ef48629160f1d1a27178318948df618074810`, last pushed at `2026-11-07T13:07:25Z`, and `open_issues_count` of 1 (the repository field may include pull requests). The local Discover category-filter fix is not part of that remote commit. No calendar or GitHub writes, new connections, schedule, or external message were made; `PayPal Project Pulse` remains saved and unscheduled.

## Fresh onboarding run — 2026-11-07 15:43:54 UTC

Loaded and followed `zapier:onboarding`, refreshed the enabled-action inventory, and ran the saved read-only `PayPal Project Pulse` flow. Calendar exposed 11 actions and GitHub 26; the current inventory contains reads, searches, and event/repository triggers, but no enabled write action. The primary Calendar was searched for events overlapping the next seven days; four matches were returned, and three hackathon/project items were surfaced in chat. Unrelated personal details and event descriptions are not retained here.

GitHub confirmed that `Protocol-X-01/paypal-agent-marketplace` is private, its default branch is `main` at `2f7ef48629160f1d1a27178318948df618074810`, the repository metadata says it was last pushed at `2026-11-07T13:07:25Z`, and `open_issues_count` is 1. GitHub's repository count may include pull requests. The saved project pulse remains read-only and unscheduled; no writes, triggers, external messages, or new connections were made.

## Fresh onboarding run — 9 November 2026

Loaded the current `zapier:onboarding` instructions and followed the read-only rundown flow. The enabled inventory remains Google Calendar (11 actions) and GitHub (26 actions), with one connected default account for each. Available lookups include Calendar events and GitHub repositories, branches, issues, pull requests, organizations, users and file contents; the inventory also includes read triggers. No write action is enabled in these connected inventories.

The primary Calendar lookup returned one PayPal-related item within the next seven days. Its title and time are intentionally kept out of this project file. GitHub's repository lookup confirmed that `Protocol-X-01/paypal-agent-marketplace` is private, uses `main` as its default branch, and reports zero open issues. The current `PayPal Project Pulse` skill already combines this Calendar and GitHub pattern; it remains read-only and unscheduled, so no duplicate skill was created.

No Calendar or GitHub data was changed, no trigger was polled, and no new account or connection was added. The connector's raw GitHub repository response included a temporary read-only clone credential; it was not used, and its value is omitted from this record. Customer events, payments and subscription actions remain outside this demonstration and require their own explicit account and action setup.

## Fresh onboarding run — 9 November 2026, 16:58 UTC

Reloaded the current `zapier:onboarding` instructions and ran the existing `PayPal Project Pulse` skill read-only. The primary-calendar window covered 9–16 November in Europe/London; two PayPal/hackathon-related items were returned, and unrelated personal calendar details were omitted. The calendar default is the user's personal Google account; GitHub is connected as `Protocol-X-01`.

The enabled inventory remains Google Calendar (11 actions) and GitHub (26 actions), with lookups, searches and read triggers; no write action is enabled in these two connected inventories. The existing project-pulse skill remains read-only and unscheduled, so no duplicate was created.

GitHub confirmed the repository remains private. Its default `main` branch is `ca3bc037ba7d428338a6c9399e0368e7923e096a`; repository metadata reports `pushed_at` as `2026-11-09T16:51:18Z` and `open_issues_count` as 0 (this repository field may include pull requests). The separate `codex/paypal-upgrade-20261109` feature branch was independently verified at `b93c72882f566aefc7bfaa349b32fc3ab88f54b8`; the feature-branch push did not update `main`.

No Calendar or GitHub records were changed, no trigger was polled, and no automation was scheduled. This confirms live on-demand reads across two connected apps, not customer-specific PayPal consent, payment authority, or an in-app Zapier connection.
