# DECISIONS

Write in English. Short bullet points are fine. Reviewers read this file alongside your code.

## What I assumed

<!-- Anything the brief did not say that you had to decide. -->

- Ties on event `at` are broken by lower event `id`, so "first" and "last" are deterministic.
- A revert drops itself and its target; a revert of a revert is not special-cased.
- Responders are grouped by staff `id`, not name (two staff can share a name, e.g. `368` and `371` are both "Marcus Lee"). The name shown is the current one from `/v1/staff`.
- Target minutes: High 60, Medium 240, Low or null 480; the boundary is inclusive (`<=`).
- A malformed `due_at` counts as "no deadline" (`completed_late: null`).
- Business time uses each site's IANA timezone via `Intl.DateTimeFormat` (no fixed offsets), so DST transitions (Sydney, 2026-10-04) are handled accurately.
- Cursors in `/api/requests` are bound to the filter + sort parameters and HMAC-signed so forged or mismatched cursors return `400`.

## What I found in the API or data

<!-- Anything that did not match the docs, or surprised you, and how you handled it. -->

- Fetching events per request is too slow (~9 requests/s, ~23 minutes for 12,000 requests vs. the 8-minute `/ready` budget).
- `GET /v1/changes` from the beginning returns all 79,692 items (160 pages) in ~58 s without hitting `429`. It includes full requests and events, so the store hydrates from the change feed instead of `/v1/requests/{id}/events`.
- Feed `seq` is not strictly monotonic (went backwards 318 times) and items can repeat. The store applies items idempotently by ID and only overwrites a request when `incoming.updated_at >= current.updated_at`.
- Real data quirks: reverts exist, requests can have multiple `due_at` events, System `processing` events have `actor_id: null`, some events carry stale `actor_name`s, and ~25% of requests have `priority: null`.
- `created_at` is UTC on the wire, so site-local creation dates are computed per site timezone before filtering by `from`/`to`.

## How I used AI

<!-- Which tools, what you asked, what came back wrong, what you changed. "I didn't use AI" is fine too. -->

- Used Antigravity to plan the architecture, write the business-hours calculator, the 7-rule evaluator, the change-feed store, the keyset pagination logic, and unit tests.
- Verified everything against the live practice API via PowerShell, Postman, and exploration scripts.
- Rejected the initial per-request `/events` approach after benchmarking showed it would miss the `/ready` deadline, switching to the `/v1/changes` stream.

## Trade-offs and what I would do next

<!-- What you left out to stay within 3 hours, and what you would do with more time. -->

- Kept the store in memory (~12,000 requests takes a few MB and serves 6-month reports in ~60 ms). Trade-off: restarting the container requires a ~58 s initial sync before `/ready` turns `200`, and HMAC cursor keys rotate on restart.
- Polls `/v1/changes` every 5 s in the background and falls back to a full resync if the cursor expires (`410`).
- With more time: persist the change-feed snapshot and cursor in SQLite/Redis for instant restarts, and add end-to-end browser tests.
