# Changelog

All notable changes to the AI HYROS dashboard template are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.3] — 2026-09-24

### Fixed
- **Preview deployments are read-only.** With Upstash connected to "all
  environments", a Refresh, setup or factory reset on a pull-request
  preview URL wrote into the production store. Every write is now refused
  when `VERCEL_ENV=preview`; `/api/refresh` answers `readOnly: "preview"`
  with a warning, `/api/setup` reports `readOnly`, and the dashboard says
  "Not persisted — preview deployment (read-only)".
- **Oversized snapshots are trimmed instead of silently never stored.**
  Upstash refuses requests over 10 MB and the snapshot is written in one
  `SET`. A snapshot over 9 MB now loses its oldest CRM rows (longest list
  first) until it fits, the trimmed lists are flagged `truncated`, totals
  are recomputed and a `truncated` warning says what was kept.

## [0.2.2] — 2026-09-23

### Fixed
- **ROAS omitted recurring revenue.** `derive()` computed ROAS as
  `revenue / cost`, but HYROS's `REVENUE` covers one-time sales only —
  rebills land in `RECURRING_REVENUE`, and `TOTAL_REVENUE` and `ROAS`
  are the ones that count both (api-docs.hyros.com, GET /attribution and
  /attribution/roas). ROAS is now `totalRevenue / cost` at every level,
  falling back to `revenue` when a row has no `totalRevenue`. Accounts
  with subscriptions were under-reporting ROAS; press **Refresh** to
  rebuild the snapshot. Profit and ROI still use `revenue` (the docs
  give no definition for them). The self-test now checks the docs'
  worked example (9,550 / 2,792.40 = 3.42).
- The Demo account's `totalRevenue` now equals `revenue + recurringRevenue`
  instead of an unrelated jitter.

## [0.2.1] — 2026-09-17

### Fixed
- The **Today** range failed on every refresh with
  `startDate or endDate cannot be in the future`: the attribution report
  rejects any bound after the current time, and the app sent
  `<today>T23:59:59` with the account offset. Today (and the CRM window's
  last day) now end at the current wall-clock time in the account
  timezone; past days still end at 23:59:59. The mock MCP rejects future
  bounds the same way, so the pipeline test catches this class of bug.
- The deadline paging check in the pipeline test no longer depends on the
  runner's speed.

## [0.2.0] — 2026-09-15

Audit release: every MCP call site checked against the September 2026
HYROS docs (REST API v1.42, MCP v1.0, Webhooks v1.2).

### Added
- `templateVersion` in every snapshot, in `/api/health` and in Setup &
  security; `/api/health` also lists `missingTools` (tools the account's
  `tools/list` lacks).
- `snapshot.warnings[]` with kinds `unsupported`, `rate_limited`, `error`,
  `truncated` and `time budget`; `crm.sync.truncated`, `crm.sync.stale`,
  `sourcesTruncated` and `ranges[key].skipped` mark partial data.
- "Copy diagnostics" button and "Report a problem" link in Setup &
  security.
- Structured JSON event lines (`logEvent`) in the Vercel runtime logs for
  refresh, setup and MCP failures; no keys, no personal data.
- CRM-only accounts (no reportable ad account) build with an empty report
  and a warning instead of failing.
- GitHub Actions workflow running `npm run check` on push and pull request;
  `npm test` as an alias of `npm run check`.
- `CHANGELOG.md`; README sections *Before you start*, *Limits*, *Getting
  updates*, *Diagnostics & support* and *Licence*.

### Changed
- The refresh is budgeted for Vercel Fluid compute: `/api/refresh` runs
  up to **300 s** (`maxDuration` in `api/refresh.js` and `vercel.json`)
  and a build spends up to 290 s, so a large account can take up to 5
  minutes to refresh. Every share derives from `REFRESH_MAX_S` in
  `api/_budget.js`; the daily cron gives each account up to 120 s and
  keeps refreshing the stalest accounts until the run budget is spent.
  Hobby projects without Fluid compute must lower `maxDuration` to 60 in
  `vercel.json` (one line) and `REFRESH_MAX_S` to match.
- One build is split into proportional reservations — attribution report
  at most 45 %, CRM at most 30 %, feature steps the rest and never under
  60 s — printed in the refresh `steps` log; a slow report pull no longer
  starves the CRM or Tracking Health.
- CRM lists (leads, sales, calls, subscriptions) and sources page up to
  10,000 rows each (was 1,000 / 500), bounded by the deadline;
  `crm.sync.truncated.<list>` is true only when the API had more rows, a
  cursor expired or the deadline cut the pull.
- Attribution levels follow the documented per-platform enum (classic
  Google `google_campaign` / `google_ad`, Google V2 `google_v2_adgroup`,
  Snapchat `snapchat_adsquad` / `snapchat_ad`, LinkedIn
  `linkedin_campaign`, Twitter `twitter_adgroup`, …); ad-account types
  with no level (REDDIT, APPLOVIN, WHOP_ADS) are skipped with a warning
  instead of failing the account.
- Per-account failures are isolated: one bad ad account no longer fails
  the whole refresh.
- Feature server steps get a fair share of the remaining refresh budget
  with a floor of min(60 s, what is left); the last step gets everything
  left; a skipped step keeps the previous block and marks it `stale`. The
  step's share is printed in the `steps` log (`feature health (72s)`).
- `ctx.timeouts = { default: 15000, slow: 45000 }` for server steps; every
  `ctx.callTool` / `ctx.callToolPaged*` clamps its timeout to what is left
  of the step and the paged helpers stop at the step deadline by default,
  so a feature can pass `ctx.timeouts.slow` to a tool known to be slow
  without ever running past its share.
- `/api/refresh` answers with `budgetMs`, `elapsedMs` and, on success,
  `counts.{ leads, sales, calls, subscriptions, warnings }` next to the
  existing `steps`, `persisted`, `storeConfigured` and `templateVersion`,
  so the client can show what a refresh fetched and how long it took.
- Attribution rows, sources and CRM lists are paginated within the refresh
  budget; the CRM shows "1,000+" when a list hit its cap.
- HTTP 429 backs off using `Retry-After` and retries inside the deadline;
  a rate-limited account is never marked as failed.
- HTTP 403 is `forbidden`, not an invalid key; only 401 marks a key
  invalid (agency keys are no longer locked out by one client).
- Incremental lead sync runs whenever the previous window overlaps the new
  one, so the daily cron is incremental too.
- IANA timezones (`America/New_York`) are understood; every date parameter
  is sent as an ISO datetime with the account's offset.
- Legacy `EEE MMM dd HH:mm:ss zzz yyyy` dates on sales, calls and
  subscriptions are parsed instead of showing "—".
- `leadStage` report settings are validated against `hyros_get_stages`
  when saved; unknown names are dropped with a warning.
- Scale Advisor parses the documented curve shape (`spendPerDay`,
  `newCustomers`, `avgCac`, `marginalCac`, `saturationPoint`,
  `ceilingBasis: CALLER_PROVIDED | LTV_BREAKEVEN`) and shows the live
  tool's HTTP 404 as an explicit error state. `HYROS_CAC_CEILING` is
  optional with no default (LTV break-even is used when absent).
- Tracking Health shows honest empty states when a check returned nothing.
- The feature template view and the conformance check handle `{ skipped }`,
  `{ error }` and stale blocks.
- Unauthenticated `GET /api/setup` returns only `state`, `storage` and
  `pendingSecrets`.
- `scripts/feature-pack.mjs` is pure Node (no `zip`, `unzip`, `cp`, `ls`)
  and runs on Windows.
- `FINDINGS.md` rewritten against the September docs: webhooks, reports
  `groupBy`/`sorting`, rate limits and caps, auth status, level enum,
  legacy dates, the CAC curve 404, undocumented fields the app relies on,
  and the updated asks for the API team. `CLAUDE.md` and the skills point
  at it and at <https://api-docs.hyros.com/llms.txt>.
- README: dev-server states, Upstash for Redis (not "Redis" / Redis
  Cloud), MCP enabled per account by HYROS support, `noindex` is a meta
  tag, generic import instructions for the beta.

### Fixed
- Malformed `vercel.json`.
- Stray `@upstash/redis` dependency removed (the app has none).
- `.vercelignore` comment (the seed is read by the dev server and the
  self-test, never by `api/data.js`); `.github`, `.claude` and scratch
  files are excluded from the deployment bundle.

## [0.1.0] — 2026-09-14

### Added
- Initial template: Performance Report (five levels, 103 metrics), CRM /
  Leads, Scale Advisor, Tracking Health, multi-account with agency import,
  Demo account, first-run setup (password + HYROS key), Upstash for Redis
  storage, daily cron, plug-and-play feature folders with pack/install,
  `npm run check` (metric parity, store, feature conformance, pipeline
  against a mock MCP).

[0.2.1]: ./CHANGELOG.md#021--2026-09-17
[0.2.0]: ./CHANGELOG.md#020--2026-09-15
[0.1.0]: ./CHANGELOG.md#010--2026-09-14
