# ADR-029: The worker's tasks live on /me; the earnings page is retired

Status: accepted (2026-10-18). Changes the frozen contract in `packages/core`: replaces `EyesService.workerEarnings` and the `WorkerEarnings` schema with `EyesService.workerTasks`, `WorkerTasks`, `WorkerTask` and `WorkerTasksQuery`; adds `HTTP_ROUTES.worker_me_tasks`; drops `earnings_url` and `tasks` from `WorkerSetup`; renames the paid text's `earnings_url` to `me_url` in `Messaging.sendPaid`. Supersedes the earnings-link part of ADR-028.

## Context
A worker had two private pages with the same `e:<worker_id>` code: the setup page `/me` (ADR-028), which showed the 5 newest claims, and the earnings page `/w/earnings/:token`, which showed totals and the 50 newest claims. Two pages for one worker meant two places to look, two renderers of the payout label rule (ADR-020), and no way to find a task older than the 50th.

## Decision
- `/me` ends with "Your tasks": the totals (paid, earned not sent yet) and every claimed task, newest first, 20 per page with "Show more".
- `GET /w/me/tasks?q=&status=&cursor=&tz=` returns one page. The code is `Authorization: Bearer <code>`, exactly as `GET /w/me`; a missing, invalid, expired or wrong-kind code gets 401 `unauthorized`. `Cache-Control: no-store`.
- Paging is keyset on `(claimed_at, task_id)`; the cursor is `<claimed_at>|<task_id>` from the last row. A malformed cursor starts from the top instead of failing.
- Search matches only what a row shows: question, place, the claim date as the browser shows it (`tz`, an IANA zone; unknown zones fall back to UTC) and the amount as `$3.00`. It never matches cents, task ids or UTC timestamps.
- Status filters: paid, pending (released, not paid out), review (needs review, disputed), expired (expired, refunded).
- Migration 026 adds `eyes_shown_date` and `eyes_worker_tasks_page`, execute revoked from public, anon and authenticated.
- `GET /w/earnings/:token` answers 301 to `<worker_web_url>/me#c=<token>` (no fragment when the token is malformed), `Cache-Control: no-store`. Links already texted keep working and the code stays out of the query string.
- The paid text says "Your tasks: <me link>" instead of the earnings link.

## Alternatives rejected
- Keep the earnings page and link it from /me: two renderers of one list, and the old 50-row cap.
- Offset paging: rows shift when a new claim lands between pages.
- Search in the browser over a full download: a busy worker's list grows without bound, and the API would send every row on each visit.

## Consequences
One page per worker. Each list request is one RPC call returning at most 21 rows. Search is an `ilike` scan over the worker's own claims; a worker with many thousands of claims would want a trigram index.
