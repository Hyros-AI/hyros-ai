# AI HYROS

Your HYROS **Performance Report**, **CRM / Leads**, **Scale Advisor** and
**Tracking Health** as a standalone dashboard, built entirely on the HYROS MCP.
You copy this repo into your own GitHub account, deploy it to your own
Vercel account, and the first load walks you through your HYROS API key
and a password. A **Demo account** is always there to explore before (or
without) connecting anything.

Exploratory build: the goal is as much to map where the MCP falls short of
powering an external tracking app as it is to ship the dashboard.
**Read [`FINDINGS.md`](./FINDINGS.md) for that map** (updated 2026-09-15
against api-docs.hyros.com).

The UI is the HYROS product-window system (cream ground, white windows, mono
labels, serif figures, one purple accent; Sep 2026).
**Before ANY visual change, read [`UI-STYLE-GUIDE.md`](./UI-STYLE-GUIDE.md).**

This is template version **0.2.2** (`package.json`; also returned by
`/api/health` and stored in every snapshot as `templateVersion`). Changes
are listed in [`CHANGELOG.md`](./CHANGELOG.md).

---

> Setting this up with Claude? Hand it [`SETUP-WITH-CLAUDE.md`](./SETUP-WITH-CLAUDE.md)
> — it carries the goal, the steps and the checkpoints.

## Before you start

- **A HYROS account.** Your API key (HYROS → Settings → API) is pasted
  into the app's connect screen once it is deployed; the dashboard uses it
  server-side only. (Should HYROS ever report that MCP access is not
  enabled for the account, support switches it on — nothing to change in
  the app.) (The HYROS MCP docs describe an OAuth sign-in for
  chat clients and say no API key is involved; this dashboard is a server,
  not a chat client, and sends the REST API key as an `API-Key` header —
  see `FINDINGS.md` §9 for the status of that path.)
- **A Vercel account** (Hobby is enough) and, for the beta, a GitHub
  account to hold your copy of the template.

## Set up in five steps

1. **Your GitHub repo.** Create an empty repo on GitHub (no README), then
   copy this template into it keeping the history:
   ```bash
   git clone <your empty repo> && cd <repo>
   git remote add upstream https://github.com/Hyros-AI/hyros-ai.git
   git fetch upstream && git checkout -b master upstream/master
   git push -u origin master
   ```
   `api/`, `public/` and `vercel.json` must sit at the top level.
2. **Vercel.** vercel.com → Add New → Project → import that repo. Leave
   the settings as shown (`vercel.json` sets framework and output
   directory). Deploy. The URL opens on the Demo account with a "Storage needs to be
   set up" card — expected.
3. **Storage — Upstash for Redis.** Vercel → the project → **Storage** →
   Create Database → **Upstash for Redis** (from the Vercel marketplace,
   free) → connect to all environments → **Redeploy**. This injects
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` /
   `UPSTASH_REDIS_REST_TOKEN`; either naming works). That store is the
   ONLY thing the app needs from Vercel: it holds snapshots, settings and
   your encrypted API keys. No environment variables to type.
   **It must be Upstash.** The Vercel marketplace also lists a product
   called just "Redis" (Redis Cloud), which injects `REDIS_URL`; the app
   speaks the Upstash REST protocol only and does not work with it.
4. **Connect.** Open the URL (or click *Check again*). One screen: **paste
   your HYROS API key** (HYROS → Settings → API) and **choose the
   dashboard password**. Tick *agency key* to add every client account you
   have access to. The first snapshot builds right away. Nothing is set in
   Vercel — the password lives in your database.
5. **Optional hardening.** Two secrets were generated for you and stored in
   the database. The last setup step shows them with copy buttons: paste
   them into Vercel as `ACCOUNT_KEY_SECRET` and `CRON_SECRET`, redeploy,
   click *I added them* — the database copies are dropped once they match.
   Everything works without this step; it keeps the encryption secret out
   of the same store as the encrypted keys and signs the daily refresh.

Skipped the store? The dashboard opens on the Demo account with a
**Storage needs to be set up** guide (Vercel → Storage → Create Database →
Upstash for Redis → redeploy) and a *Check again* button.

No environment variables are required, and none of them decide whether the
dashboard is set up — only the database does. The HYROS MCP endpoint
(`https://mcp.hyros.com/mcp`) is built in. A first run is a fresh start: it
wipes whatever an earlier install left in the store.

### Optional environment variables

| Variable | Effect |
|---|---|
| `ACCOUNT_KEY_SECRET` | Encrypts stored API keys. Generated on first load if absent; the setup screen helps you move it here. |
| `CRON_SECRET` | Signs the daily refresh. Generated on first load if absent. Until it is set in Vercel the cron is recognised by its user agent and limited to one run per hour. |
| `REPORT_PASSWORD` | Optional MASTER password: accepted in addition to the one created on first load (recovery if someone else reached the first-run screen first). It never blocks or replaces setup. |
| `HYROS_MCP_URL` | Override the MCP endpoint (staging, mocks). |
| `HYROS_CAC_CEILING` | Scale Advisor CAC ceiling at the ad-account level. Optional, **no default**: when absent HYROS derives the ceiling from the entity's LTV break-even (ad sets) and reports none at the account level, instead of the app inventing one. |
| `HYROS_ATTRIBUTION_MODEL`, `HYROS_AD_ACCOUNTS` | Snapshot defaults. |

### Setup & security (account menu)

Change the password, see where each secret lives, show the pending
secrets again, copy a diagnostics report, report a problem, or **factory
reset** — every account, snapshot, setting and the password are deleted
from the database and the dashboard returns to first-load setup. The
Vercel project and your HYROS accounts are untouched.

---

## Adding features (plug and play)

Every tab beyond Performance Report and CRM is a **feature folder** under
`public/features/<id>/` — manifest, view, demo data, optional server step,
styles and a portable `SPEC.md`. The core app discovers them from
`public/features/registry.js`; nothing else needs editing. Zip one with
`node scripts/feature-pack.mjs <id>` and install it in another fork with
`--install` (pure Node, runs on Windows too). **Read
[`FEATURES.md`](./FEATURES.md)** for the contract and
[`CLAUDE.md`](./CLAUDE.md) for the build rules an LLM session must follow;
`.claude/skills/add-feature` and `port-feature` drive the workflow.

## What it does

**Performance Report** — five levels (Traffic source · Account · Campaign ·
Ad Set · Ad), 103 selectable metrics, date-range chips, client-side
sort/filter/search, sticky totals, CSV export, click-through from any number
to the lead cohort behind it and on to each lead's journey.

**CRM / Leads** — the real column set (Joined on, Lead, Name, First Source,
Last Source, Last Source Date, Income, Stage, Ad O.C., Tags), sales, calls,
subscriptions, stage and attribution filters, search, CSV export.

**Scale Advisor** — marginal CAC curves per account and top ad set
(`hyros_get_marginal_cac_curve`), with the saturation point called out.
The tool currently answers HTTP 404 on the live MCP (raised with HYROS);
the tab says so instead of showing an empty chart.

**Tracking Health** — domains, script presence per URL, Google tracking
parameters per integration.

**Accounts** — any number of HYROS accounts in one dashboard, switched from
the top-left menu. An agency key adds every approved client account (5 per
call) and the daily refresh rotates through the stalest ones.

**Demo account** — always in the account menu. Synthetic, profitable-looking
data generated in the browser with the same math as the live pipeline; also
unlocks the Funnel & Journey and Ad LTV preview tabs.

## How it works

```
Vercel Cron (daily)  ─┐
Refresh button       ─┴─►  /api/refresh  ──►  HYROS MCP  (POST /mcp, API-Key)
                                          │
                                          ├─► builds one flat snapshot per account
                                          └─► Upstash for Redis (REST)
                                                   │
                          browser  ◄── /api/data ◄─┘
```

The browser never talks to HYROS. `/api/refresh` is the only MCP client, and it
speaks plain JSON-RPC over `fetch` — no SDK, no dependencies.

The HYROS MCP is Streamable HTTP on `/mcp`; every call the app makes is a
self-contained JSON-RPC POST authenticated with an `API-Key` header, so a
serverless function can be an MCP client with no session to hold open.
That header is not in the MCP docs (which describe OAuth for chat clients)
but works today; `FINDINGS.md` §9 tracks it.

Every snapshot records `templateVersion`, `schema` and a `warnings[]` list
(`unsupported`, `rate_limited`, `error`, `truncated`, `time budget`) so the
UI can say exactly which part of a refresh is partial.

### Levels

HYROS's Meta level names are display names over its own hierarchy:
**Campaign = source category**, **Ad Set = source link**. The synchronous
attribution report has no campaign or traffic-source grouping, so those
levels are rolled up from the ad-set base table joined to
`hyros_get_sources`. (The asynchronous reports tool can group by source
category and traffic source; the refresh does not use it.) Derived metrics
(ROAS, ROI, CTR, CPM, CPL) are always **re-derived** after summing, never
averaged.

## Limits

- **Rate limit.** HYROS limits requests per *account* (30 per second,
  1,000 per minute by default), not per key — an agency key and all its
  clients share one budget. On `429` the app waits for `Retry-After` and
  retries inside its time budget; what still cannot be fetched is recorded
  as a `rate_limited` warning, never as a failed key.
- **CRM lists.** Leads, sales, calls and subscriptions are pulled up to
  **10,000 rows each** (40 pages of 250) per 30-day window, in parallel,
  inside the CRM's share of the refresh budget. `crm.sync.truncated.<list>`
  is set only when the API still had more rows at the cap, a pagination
  cursor expired, or the deadline cut the pull; the CRM then shows the
  count with a **"+"** and keeps the newest rows. Leads sync incrementally
  when the previous snapshot's window overlaps the new one; sales, calls
  and subscriptions are full pulls. Sources page to 10,000 as well.
- **Sources and attribution rows** are paginated within the refresh
  budget; when the budget runs out the snapshot carries
  `sourcesTruncated` or `ranges[key].skipped` and the header shows a
  warning. A range marked `skipped` keeps the previous snapshot's rows
  and is labelled stale.
- **Refresh budget.** A refresh may take **up to 5 minutes** on a large
  account: `/api/refresh` runs for at most 300 s (Vercel Fluid compute,
  the default for new Hobby and Pro projects) and one build spends up to
  290 s of it — at most 45 % on the attribution report, 30 % on the CRM
  and the rest (never under 60 s) on the feature steps, so a slow report
  pull cannot starve the CRM or Tracking Health. The reservations are
  printed in the refresh `steps` log. The daily cron refreshes the
  **stalest accounts first**, giving each up to 120 s and continuing until
  the 290 s run budget is spent, so an agency with many clients sees them
  refreshed over several runs; press Refresh on an account to bring it
  forward. Until `CRON_SECRET` is set the unsigned cron is limited to
  **one run per hour**. Every number derives from `REFRESH_MAX_S` in
  `api/_budget.js`. **Hobby projects without Fluid compute** are capped at
  60 s: change the one line in `vercel.json`
  (`"api/refresh.js": { "maxDuration": 60, … }`) and `REFRESH_MAX_S` to
  60; every share scales down with it.
- **Scale Advisor** covers every ad account plus the six biggest ad sets by
  30-day spend; **Tracking Health** checks the script on up to 5 verified
  domains and lists 50 tracking-parameter rows per integration type.

## Getting updates

Your deployment is your own copy of the template, so updates are a git
merge:

- The `upstream` remote added at setup points at the template; merge
  whenever a new version ships and Vercel redeploys on push:
  ```bash
  git fetch upstream
  git merge upstream/master
  git push
  ```
  (Missing the remote? `git remote add upstream
  https://github.com/Hyros-AI/hyros-ai.git`. Installed from a zip or a
  fresh `git init`, so the histories are unrelated? Add
  `--allow-unrelated-histories` to the first merge.)
- Feature folders you added under `public/features/` and your entry in
  `registry.js` merge cleanly; conflicts only arise in files you edited.
- When the snapshot `schema` number changes, the dashboard shows "old
  snapshot — needs a Refresh"; press **Refresh** and the snapshot is
  rebuilt. Nothing else migrates.
- The current version is in `CHANGELOG.md`, `/api/health`
  (`templateVersion`) and Setup & security.

## Diagnostics & support

- **Copy diagnostics** (Setup & security) copies a JSON report: template
  version, setup state, storage variables in use, the last refresh's steps
  and warnings, and `missingTools` from `/api/health`. It contains no keys,
  passwords or lead data — paste it into a support request.
- **Vercel runtime logs** (project → Logs) contain one JSON line per
  refresh, setup or MCP failure (`{"evt": …, "code": …, "tool": …}`),
  without personal data. Share the relevant lines with the diagnostics.
- **Report a problem** in Setup & security links to the template's issue
  tracker.
- `GET /api/health` with the password in the `x-report-key` header
  (`curl -H 'x-report-key: <password>' https://<your app>/api/health`)
  proves the MCP leg without building a snapshot: tool count,
  `missingTools`, account email and timezone.

## Files

```
api/_mcp.js        JSON-RPC client (streamable HTTP, JSON + SSE framing, per-account key context, 429 back-off)
api/_snapshot.js   the pipeline: MCP calls -> levels -> CRM -> feature steps -> one snapshot (+ warnings)
api/_store.js      Upstash for Redis via REST, fails soft
api/_setup.js      first-run config: password hash, generated secrets, hardening, factory reset
api/_auth.js       password gate (env or KV), timing-safe; cron recognition
api/_accounts.js   multi-account registry, AES-256-GCM key storage, agency client import
api/setup.js       GET state / POST set-password | change-password | harden | reset
api/accounts.js    list / add / import-clients / replace-key / remove
api/refresh.js     rebuild + persist (cron rotates accounts; on demand per account)
api/data.js        the selected account's snapshot
api/drill.js       number -> lead cohort -> journey (live)
api/health.js      prove the MCP leg without building anything; templateVersion + missingTools
public/app.js      dashboard shell;  public/demo.js  the Demo account
public/shared/metrics.js   metric definitions + rollups (shared server & client)
public/shared/features.js  feature loader (browser + Node)
public/features/   registry.js + one folder per feature (FEATURES.md); _template/ to copy
api/_features.js   runs every feature's server.js inside the refresh budget
scripts/feature-check.mjs  feature conformance (in npm run check)
scripts/feature-pack.mjs   export / install feature zips (pure Node)
data/seed.json     SYNTHETIC preview snapshot for the local dev server and the self-test (no customer data)
scripts/devserver.mjs   local preview on :4321 (DEV_SETUP_STATE=ready|needs_storage|needs_setup)
scripts/selftest.mjs    metric parity + seed integrity
scripts/store-test.mjs  store, setup, accounts and auth against an in-memory KV (in npm run check)
scripts/feature-unit-test.mjs   unit tests for feature code and helpers (in npm run check)
scripts/mock-mcp.mjs    the mock MCP the pipeline test and the dev server talk to
scripts/make-seed.mjs   regenerates data/seed.json (npm run seed)
scripts/pipeline-test.mjs   the whole pipeline + accounts + setup against a mock MCP
.github/workflows/check.yml   runs npm run check on every push and pull request
CHANGELOG.md       what changed per version
```

## Run locally

```bash
node scripts/devserver.mjs                          # http://127.0.0.1:4321  (password: dev)
DEV_SETUP_STATE=needs_setup node scripts/devserver.mjs     # walk the first-run flow
DEV_SETUP_STATE=needs_storage node scripts/devserver.mjs   # the storage gate
npm run check                                       # metric parity + store + features + pipeline + setup
npm test                                            # same as npm run check
```

## Verification

`npm run check` asserts the metric engine against numbers read off a **live
HYROS Performance Report** (2026-08-13→19, Traffic source, Last Click):

| Metric | HYROS UI | Formula |
|---|---:|---|
| Profit | 556,162.19 | `revenue - cost` |
| Reported vs Revenue | 559,391.77 | `revenue - reported` |
| ROI | 13,467.77% | `(revenue - cost) / cost * 100` |
| ROAS | 135.68 | `totalRevenue / cost` (one-time + recurring; equal to `revenue` on this account) |

All four match exactly. The suite also covers divide-by-zero behaviour, the
re-derive-don't-average rollup rule, seed integrity, the incremental lead
sync, agency client import, key encryption, and the whole first-run setup
(password, generated secrets, hardening, factory reset). The pipeline test
runs against `scripts/mock-mcp.mjs`; a live feature is verified on a
deployed preview by pressing Refresh and reading the snapshot block.

## Security notes

- The dashboard shows customer emails, phone numbers and revenue: pick a long
  password. `<meta name="robots" content="noindex, nofollow">` is set in
  `public/index.html`; `X-Frame-Options: DENY`, `nosniff` and
  `strict-origin-when-cross-origin` ship as headers in `vercel.json`.
  Consider Vercel Deployment Protection on top.
- API keys are AES-256-GCM encrypted at rest and never leave the server; the
  browser only ever sees account ids and labels.
- The first-load screen is first-come: whoever opens a fresh deployment
  first sets the password. Open your URL right after deploying. If that
  ever goes wrong, set `REPORT_PASSWORD` in Vercel as a master password,
  sign in with it and factory-reset.
- Unauthenticated `GET /api/setup` returns only the setup state, whether
  storage is configured and whether secrets are pending — nothing else.

## Licence

Not yet decided. `package.json` says `UNLICENSED` on purpose: HYROS decides
the template licence before the public release, and a `LICENSE` file will
be added then. Until that point the template is for HYROS beta users only.
