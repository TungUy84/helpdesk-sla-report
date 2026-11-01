# DECISIONS

Write in English. Short bullet points are fine. Reviewers read this file alongside your code.

## What I assumed

<!-- Anything the brief did not say that you had to decide. -->

- Ties on `at` are broken by lower event `id`, so "first" and "last" are deterministic.
- A revert drops itself and its target; a revert of a revert is not special-cased.
- Responders are grouped by staff `id`, not name (two staff can share a name, e.g. "Marcus Lee"). The name shown is the current one from `/v1/staff`.
- Target minutes: High 60, Medium 240, Low or null 480; the boundary is inclusive.
- A malformed `due_at` counts as "no deadline" (`completed_late: null`).
- Business time uses the site's real timezone rules (no fixed offsets), so DST is handled (Sydney, 2026-10-04).

## What I found in the API or data

<!-- Anything that did not match the docs, or surprised you, and how you handled it. -->

- Fetching events per request is too slow: about 9 requests/s, so roughly 23 minutes for 12,000 requests (limit for `/ready` is 8 minutes).
- `GET /v1/changes` read from the start returns everything (79,692 items, 160 pages) in about 58 s with no `429`. It carries full requests and events, so I use it instead of `/events`.
- The feed is not strictly ordered: `seq` goes backwards 318 times, and items can repeat. The store must apply items by id, idempotently.
- Data quirks in a sample: reverts exist, some requests have several `due_at`, 43 `processing` events have no actor (System), 15 events have an outdated `actor_name`, and about a quarter of requests have `priority: null`.
- `created_at` is UTC but the report range is a site-local date, so the local date is derived per site.
- A `429` carries `Retry-After`; the client honours it and backs off on `429`, `5xx` and network errors.

## How I used AI

<!-- Which tools, what you asked, what came back wrong, what you changed. "I didn't use AI" is fine too. -->

- Antigravity helped plan the levels and draft the business-hours code, the API client, the rules code and the unit tests. I reviewed and ran everything, and explored the real API by hand.
- Its first idea (events per request) was too slow when measured, which led to the change-feed design.

## Trade-offs and what I would do next

<!-- What you left out to stay within 3 hours, and what you would do with more time. -->

- Done: business-hours calculation, per-request rules, API client, data exploration.
- Next: in-memory store loaded from the feed with `/ready`, `/api/sla-report` and a simple page, live updates from the feed, then `/api/requests` with cursor paging.
- In-memory store is enough for about 12,000 requests; the cost is a reload of about a minute after a restart.
- With more time: integration tests with a fake feed (duplicates, out-of-order items, reverts).
