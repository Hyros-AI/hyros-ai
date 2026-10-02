# HYROS MCP — what it can and cannot do for an external app

**Updated 2026-09-15** against the official docs at api-docs.hyros.com
(REST API v1.42, MCP v1.0, Webhooks v1.2; machine-readable index:
<https://api-docs.hyros.com/llms.txt>). **When in doubt the official docs
win** over anything written here. "Verified live" below means a call made
against the production MCP on the date given; "undocumented" means the
behaviour is real today but appears in no HYROS document, so it can change
without notice.

The MCP docs cover connection, auth, agency mode, rate limits and the tool
list only. For what a field means or which values are valid, the REST API
reference is the authority — the tools "operate on the same data model".

---

## 1. "Campaign" is not a Meta campaign — still the headline finding

`hyros_get_attribution_report` with `level: FACEBOOK_CAMPAIGN` and
`isAdAccountId: true` returns `[]`. `facebook_campaign` is a documented
level (the `/attribution` enum lists it), but with an ad-account id it
answers an empty array rather than an error. The HYROS UI's own "Campaign"
tab is a **source category** (`SOURCE_CATEGORY`), and "Ad Set" is a source
link (`SOURCE_LINK`). Categories come back on `hyros_get_sources`
(`category.name`), so the level is reconstructible: pull ad-set rows, join
to sources, group by category. That is what `buildLevels()` does.

New since the last audit: the asynchronous reports tool
(`hyros_generate_public_report`, section 7) groups by `SOURCE_CATEGORY`,
`TRAFFIC_SOURCE` and `AD_ACCOUNT` server-side, and `hyros_get_roas_report`
accepts `level: campaign` on Meta, Google and LinkedIn. The synchronous
`/attribution` report is unchanged, so the client-side rollup is still the
path the refresh uses.

**Impact: not a blocker.** The empty-array behaviour is still an ask
(section 15).

## 2. Lead attribution is exposed — only for tracked-click leads

`firstSource` / `lastSource` on `hyros_get_leads` are populated (name, tag,
organic flag, traffic source, category, `clickDate`) for leads that
arrived via a tracked click and omitted otherwise (docs: "Omitted when
unknown"). Leads created by payment or CRM integrations have no click
history, so their source is genuinely absent. Sample from recent *sales*
and it looks like total attribution failure; sample from recent *leads*
and a third are attributed. The dashboard exposes the distinction as an
"Attributed only / Unattributed only" filter.

## 3. Lead income needs a join the MCP does not do

The `Lead` object has no income or revenue field. The CRM's Income column
is built by pulling `hyros_get_sales` and summing by email — an N+M fetch
that grows with lead volume and is capped by the CRM page budget
(section 10). `hyros_get_stages` (per-stage lead counts, optionally scoped
with `stageFromDate` / `stageToDate`) and `hyros_get_tags_count` give
honest totals without paging every lead.

## 4. Level totals do not reconcile — and the docs now say why

Same account, window and model: ad-set level cost $4,266.30, the
account report (DAY grouping) $4,196.62, ad level $2,852.99. The MCP docs
explain the first gap: the ad-account report "counts deleted source links"
by default; pass `reportSourceVisibility: true` to exclude them and match
the report screens. Ad level covers only ~67% of ad-set spend because spend
exists at ad-set level without an ad row. **Do not treat any level as a
cross-check on another.** To match the HYROS report screens pass
`sourceConfiguration: ALL_SOURCES` (the default `PRIORITIZE_PAID` credits
a sale closed by an organic click to the previous paid click).

## 5. Webhooks exist (this file used to say "pull-only")

The Webhooks API (v1.2) delivers eleven event types by POST to a target
URL: `sale.attributed`, `sale.refunded`, `lead.opted.in`,
`lead.opted.in.first.time`, `lead.origin.assigned`, `lead.stage.changed`,
`lead.tag.added`, `lead.tag.removed`, `call.attributed`,
`subscription.created`, `subscription.status.changed`.

- Every event carries `eventId` for deduplication.
- Requests are signed with the subscription's `secretKey`:
  `X-Hyros-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`
  (recommended; the docs ship a verifier with a 300 s tolerance).
  `X-Hyros-Hmac-Sha1` is deprecated but still sent.
- Subscriptions are managed over REST (`/webhook-subscriptions`). The live
  connector also exposes `hyros_create_webhook_subscription`,
  `hyros_get_webhook_subscriptions` and `hyros_delete_webhook_subscription`,
  which the MCP tool list does not document.

The dashboard does not use webhooks yet: it snapshots on a schedule. A
`/api/webhook` route writing to the store would replace the full
sales/calls/subscriptions pulls (section 15, "updatedSince").

## 6. Sort and filter: the synchronous report has none, the async one does

`/attribution` (`hyros_get_attribution_report`) takes no sort parameter.
Filters are `status` (only at `SOURCE_LINK` grouping), `lead_stage` and
`newestFirst`. Every sort and filter in the HYROS UI is reimplemented
client-side over a full fetch. The reports tool (section 7) has `sorting`,
but it is asynchronous and ignored for the traffic, cohort, journey and
sale-item families. Server-side sort / top-N on `/attribution` is with the
API team (status: investigating).

## 7. Reports: `groupBy`, `sorting`, `fields`, `timeZone` — asynchronous

`hyros_generate_public_report` starts a report and answers an id;
`hyros_poll_public_report_result` returns `status`
(`IN_PROGRESS | SUCCESSFUL | FAILED | EXPIRED`) and the rows. The
configuration always has `groupBy`, `startDate`, `endDate` (`yyyy-MM-dd`,
inclusive); optional `timeZone` (`+HH:mm` offset), `reportAttribution`,
`filters`, `fields` (a requested metric is always present, null when
empty), `settings`, `sorting`, `timeSegmentation` (source family only),
`customMetricIds`.

`groupBy`: `SOURCE, SOURCE_CATEGORY, TRAFFIC_SOURCE, AD_ACCOUNT, GOAL, AD,
CREATIVE, KEYWORD, SALE_ITEM_LTV, SALE_ITEM_TOTAL, COUNTRY, REGION, CITY,
DEVICE_TYPE, DEVICE_PLATFORM, REFERRER_DOMAIN, REFERRER_URL, JOURNEY,
COHORT`. `JOURNEY` returns conversion paths (`journeySteps`, `journeyId`),
30 journeys per call, paged by resending
`pagination.alreadyProcessedJourneyIds`; `options.journeyKeyMetric` is
`TOTAL_REVENUE | SALES | CALLS | CUSTOMERS`.

The report tools do **not** accept `accessible_account_id`, so an agency
cannot run them for a client through its own key. The two-step model fits
the daily cron, not the synchronous Refresh button; the dashboard does not
use it yet.

## 8. One query per date range

`isAdAccountId: true` forces `timeGroupingOption: SOURCE_LINK` (the docs:
day/week/month/year grouping with an ad-account id "fails"), so there is no
per-source-per-day series to slice locally. Today / Yesterday / 7d / 30d
are four queries per level per ad account. Alternatives: the account
report (`hyros_get_ad_account_report`) with `adLevelDateGroupingOption:
DAY` gives a daily series per ad account; reports `timeSegmentation`
buckets the source family in one call.

## 9. Auth and transport — the template runs on undocumented behaviour

Per the MCP docs the server is **OAuth 2.1 only**: PKCE (`S256`), dynamic
client registration, scope `mcp`, 15-minute access tokens with refresh,
`Authorization: Bearer` header only; "the server issues no API keys and no
long-lived tokens". Transport is Streamable HTTP; SSE is not offered.

What the template does: every call is a self-contained JSON-RPC POST to
`https://mcp.hyros.com/mcp` with an `API-Key: <REST API key>` header. This
**works today (verified live 2026-09-15)** and is what makes a serverless
function a viable MCP client — there is no interactive sign-in to hold.
It is **not documented anywhere** and has been flagged to HYROS; a written
confirmation (or a service-token path) is the P0 ask in section 15. The
earlier claim that the server runs a Spring AI "stateless" transport came
from reading HYROS source, not from the docs.

**MCP access is granted per account by HYROS support**, not self-serve
(docs, Prerequisites). A key from an account without it is refused with
raw MCP text; the setup screen maps that to "ask HYROS support to enable
MCP", but there is no structured error code yet (ask, section 15).

Error semantics the app relies on: `401` = the key is rejected;
`403` = a valid key missing a role, or an unauthorized client target —
the app no longer marks the key invalid on 403.

## 10. Rate limits and array caps (documented)

- Limits are **per HYROS account, not per key**: every key of the account,
  and every client an agency addresses, draws from the caller's budget.
- Defaults: **30 requests/second and 1,000 requests/minute**, adjustable
  per account. MCP tool calls share **one budget for the whole `/mcp`
  endpoint**, separate from the REST API's per-endpoint budgets.
- Headers on authenticated responses: `X-RateLimit-Limit`
  (`30;w=1, 1000;w=60`), `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
  A rejected request is `429` with `Retry-After` (seconds) and a body of
  `{"error": "<string>"}` — a string, not `error.message`.
- Array arguments are capped at **50**: `ids`, `emails`, `phones`, `tags`,
  `leadIds`, `stages` (20 for `productTags`); `pageSize` is 1–250;
  `hyros_get_lead_journey` takes at most 50 leads per call.
- Strict endpoints (`/attribution`, `/attribution/roas`,
  `/attribution/marginal-cac-curve`, `/reports/*`) reject unknown
  parameters with `400`.

The app now backs off on 429 (reads `Retry-After`, retries inside the
deadline), records `rate_limited` in `snapshot.warnings`, and never marks a
rate-limited account as failed.

## 11. Attribution `level` per platform

> **Live enum ≠ REST docs (observed 2026-09-21).** The MCP at mcp.hyros.com
> answers an invalid level with its own accepted list, in UPPERCASE:
> `GOOGLE_CAMPAIGN, GOOGLE_ADGROUP, GOOGLE_AD, GOOGLE_KEYWORD, FACEBOOK_ADSET,
> FACEBOOK_CAMPAIGN, TIKTOK_ADGROUP, SNAPCHAT_ADSET, PINTEREST_ADGROUP,
> TWITTER_ADGROUP, BING_ADGROUP, FACEBOOK_AD, TIKTOK_AD, SNAPCHAT_AD,
> PINTEREST_AD, TWITTER_AD, BING_AD, LINKEDIN_CAMPAIGN, LINKEDIN_AD,
> GOOGLE_V2_KEYWORD, GOOGLE_V2_ADGROUP, GOOGLE_V2_AD, GOOGLE_V2_CAMPAIGN`.
> Differences from `GET /attribution`: Snapchat is `SNAPCHAT_ADSET` (docs:
> `snapchat_adsquad`, which the MCP rejects); the MCP also lists
> `LINKEDIN_AD`, `TWITTER_AD`, `GOOGLE_V2_AD`, `GOOGLE_V2_CAMPAIGN` and
> `GOOGLE_KEYWORD`. Accepted is not supported: classic `GOOGLE` still
> rejects `GOOGLE_ADGROUP` ("Unsupported level type … for user integration").
> The claude.ai Hyros connector exposes the REST list, so the two MCP
> surfaces disagree — ask for one enum.

| Ad account `type` | ad-set level | ad level | notes |
|---|---|---|---|
| FACEBOOK | `facebook_adset` | `facebook_ad` | `facebook_campaign` exists but answers `[]` with an ad-account id |
| GOOGLE (classic) | `google_campaign` | `google_ad` | |
| GOOGLE_V2 | `google_v2_adgroup` | — | `google_v2_keyword` with `keywordsIds` for keywords |
| TIKTOK | `tiktok_adgroup` | `tiktok_ad` | |
| SNAPCHAT | `snapchat_adsquad` | `snapchat_ad` | |
| PINTEREST | `pinterest_adgroup` | `pinterest_ad` | |
| BING | `bing_adgroup` | `bing_ad` | |
| TWITTER | `twitter_adgroup` | — | |
| LINKEDIN | `linkedin_campaign` | — | campaign is the only level |
| REDDIT, APPLOVIN, WHOP_ADS | — | — | no attribution level; the app skips them with a warning |

`hyros_get_roas_report` and `hyros_get_marginal_cac_curve` use the generic
vocabulary `ad | source_link | campaign | account` instead; campaign level
is available on Meta, Google and LinkedIn only. The app sends these enums
in UPPERCASE (section 14).

## 12. Dates, timezones and legacy formats

- Request dates are ISO 8601 with a time in every documented example
  (`2021-04-13T10:00:00`, `2023-05-01T10:00:00-03:00`); list filters are
  worded as strict bounds. The app sends `T00:00:00` / `T23:59:59` with the
  account's offset.
- `timezone` on the user profile is a free string; IANA names
  (`America/New_York`) are what real accounts return. The app resolves them
  with `Intl.DateTimeFormat`.
- **Legacy dates:** `/sales`, `/calls` and `/subscriptions` return
  `creationDate`, `refundDate`, `startDate` etc. as
  `EEE MMM dd HH:mm:ss zzz yyyy` (e.g. `Tue Mar 01 10:00:00 ART 2022`),
  not ISO 8601, and the lead embedded in those responses uses the same
  format. `/carts` is ISO. `new Date()` on the legacy form is
  `Invalid Date`; the app parses it explicitly.
- `lead_stage` must match an account stage name (case-insensitive); an
  unknown name is a `400` listing the valid names. The app validates the
  saved setting against `hyros_get_stages`.

## 13. Marginal CAC curve: documented shape (404 until late September)

`hyros_get_marginal_cac_curve` (`GET /attribution/marginal-cac-curve`):
`{ id, level: ad|source_link|campaign|account, startDate?, endDate?,
ltvWindow?, cacCeiling?, attributionModel?: first_click|last_click }`.
Account level caps day-grouped ranges at 90 days, has no LTV, and rejects
`ltvWindow` — the ceiling there is the caller's `cacCeiling` or none.

Documented response (`result`): `id, level, name` (null at account level),
`startDate, endDate, attributionModel, daysSampled, cacCeiling,
ceilingBasis: CALLER_PROVIDED | LTV_BREAKEVEN, ltvWindow`,
`curve: [{ spendPerDay, days, newCustomers, avgCac, marginalCac }]`
ordered by spend, `saturationPoint: { efficientSpendPerDay,
saturatedSpendPerDay, reason } | null`, `notes: []` (`NO_SPEND_DATA`,
`NO_CUSTOMERS`, `INSUFFICIENT_DATA`, `LTV_CEILING_UNAVAILABLE`).

**Verified live 2026-09-15: the tool returned HTTP 404** for both `account`
and `campaign` levels. A beta account reported it answering for every ad
account on 2026-09-30. Scale Advisor parses the documented shape (with
fallbacks) and still shows a failure as an explicit error state instead
of an empty chart. At account level there is no LTV, so without a caller
`cacCeiling` there is no ceiling and no saturation point; a thin curve
(3 spend levels, two with no customers) came back without
`INSUFFICIENT_DATA`. Asks in section 15.

## 14. Undocumented behaviour the app relies on

Everything below is real on the live MCP and absent from the docs; each is
a documentation ask.

- `parentId` on ad-level attribution rows (only `parent_name` is a
  documented field). Ad → ad-set linkage depends on it.
- Tool arguments travel inside a `{ request: { … } }` wrapper, and enums
  (`level`, `attributionModel`, `fields`, `timeGroupingOption`) are
  UPPERCASE, while the REST docs show lowercase / snake_case
  (`reported_result` vs `reportedResult` on rows). The MCP docs never show
  a tool's argument shape.
- `windowAttributionDaysRange` (0–365) is accepted with `LAST_CLICK` only —
  observed, not stated.
- `hyros_get_attribution_report` rejects any `startDate` / `endDate`
  after the current time (`startDate or endDate cannot be in the future.`,
  observed 2026-09-17), so a "today" range must end at the current time,
  not at 23:59:59. Not stated in the docs.
- `hyros_assert_script_presence_on_domain { domains: [url…] }` returns a
  map `url → SCRIPT_FOUND | SCRIPT_NOT_FOUND`;
  `hyros_check_tracking_parameters_for_integrations { request: { type } }`
  (`SEARCH`, `PERFORMANCE_MAX`) returns rows whose shape the app reads
  tolerantly. Neither request nor response is documented.
- `usdPrice` on sales; `price.currency` exists but the app prints the
  account currency.
- `hyros_get_lead_clicks` accepts `email` (deprecated in favour of
  `emails`); the connector also lists `hyros_get_clicks`, undocumented.
- `accessible_account_id` **is** documented now: an optional tool argument,
  advertised in `tools/list` only to agency accounts but validated on
  every call, with explicit errors (`Not authorized: account <id> is not
  one of your connected client accounts.` / `… is not active.`). The app's
  runtime probe of it is belt and braces, not a workaround.

## 15. Asks for the HYROS API/MCP team (prioritised)

| P | Ask | Symptom in the dashboard | Status |
|---|---|---|---|
| P0 | Confirm in writing and document `API-Key` auth on `/mcp`, or provide a non-interactive OAuth / service-token path | Template-wide outage risk; users reading the docs are told no key exists | flagged |
| P0 | Why does `hyros_get_marginal_cac_curve` return HTTP 404? Is it deployed? | Scale Advisor shows an error card | **answering since late Sep** (beta report 2026-09-30) |
| P0 | Structured error codes: MCP not enabled for the account / invalid key / client not authorized | Raw text on the setup screen | new |
| P1 | `updatedFromDate` / `updatedToDate` on sales, calls and subscriptions | Full re-pull every refresh; CRM cap | **shipped for sales and calls** (used since 0.2.6); subscriptions still full |
| P1 | Total counts (or counts by stage / tag / day) on paged lists | "1,000+" instead of a real total | **in QA** (group-by counts) |
| P1 | Synchronous `sort` + `limit` on `/attribution` with `isAdAccountId` | Top-N computed from the newest 250 sources | **investigating** |
| P1 | Document `parentId` on ad rows, the `{ request }` wrapper and enum casing, the two Tracking Health tools, `ceilingBasis`, the `windowAttributionDaysRange` model rule | Code relies on undocumented behaviour | new (docs) |
| P1 | `reportSourceVisibility` on `hyros_get_attribution_report` (today only the ad-account report has it), and `ALL_SOURCES` + visibility as the default on both report tools | Per-ad rows count deleted source links and can differ from app.hyros.com; the `PRIORITIZE_PAID` default inflated one beta account ~6× in sales and 2× in ROAS | new (beta feedback) |
| P1 | `hyros_assert_script_presence_on_domain` should inspect the rendered page (scripts injected by site builders read `SCRIPT_NOT_FOUND`), follow redirects, and answer within the call timeout (`TIMEOUT_ERROR` on some sites) | Tracking Health cross-checks with `hyros_get_lead_clicks` to avoid false "not found" | new (beta feedback) |
| P1 | `hyros_generate_public_report` `options.comparison { enabled: true, compareBy: DATES }` returns the current period only; `B_*` fields are rejected as "metrics this report does not publish" | Growth vs previous period needs a second raw pull | new (beta feedback) |
| P1 | 429 semantics on MCP tool calls (HTTP 429 vs JSON-RPC error; `retryAfter` in the tool error) | Back-off is best-effort | new |
| P2 | `hyros_get_marginal_cac_curve`: flag thin curves (`INSUFFICIENT_DATA` was absent on 3 spend levels / 19 days, two levels with no customers) and document the threshold | A thin curve renders without a warning | new (beta feedback) |
| P2 | Source, category and link names stored with a letter substitution (`dbbduvat` for `coaching`, `fzbvy-cebbedbfg` for `email-broadcast`: a–e shifted +1, g–z +13), seen in the HYROS app itself — which creation path could store names encoded? | Garbled names in every source-based tab | new (question, cause unconfirmed) |
| P2 | Honour the `fields` projection on `/attribution` (payloads are ~90% null, ~120 fields per row) or document that it does not trim | Payload size; unverified on the bound account | open |
| P2 | Explicit error (or `SOURCE_CATEGORY` semantics) for `facebook_campaign` instead of `[]` | Silent empty array reads as missing data | open |
| P1 | LTV fields (`LTV_*`, `LTV_*_FORECAST`) return 0 on every row of the attribution and public reports (HMCP-359) | The template switches the 10 LTV columns off until fixed | new |
| P2 | `income` / LTV fields on the Lead object | CRM Income needs a capped sales join | open |
| P2 | Bulk conversion paths: sync or paged `JOURNEY` beyond 30 per call, or a `touched` aggregate (`attributionMode: CREDIT | TOUCHED`) | Funnel & Journey and Ad LTV tabs are demo-only | **in QA** |
| P2 | Document tools the connector exposes but the docs omit: webhook subscription tools, `hyros_get_clicks`, `hyros_get_ads` / `hyros_get_keywords` request shapes | Assistants cannot use them safely | new (docs) |
| P2 | Confirm `accessible_account_id` on `hyros_get_user_info` returns the client profile | Agency import marks clients unsupported on a false negative | new (docs) |
| P2 | Aggregate clicks query (`groupBy: url | source | day`) and a platform-agnostic report level for organic / custom sources | No traffic denominators; organic sources unreportable on `/attribution` | open (out of scope for v1) |

## 16. Scorecard

| Feature | Fidelity | Limiting factor |
|---|---|---|
| Performance report | ~90% | Campaign needs a client-side join; no sync sort/filter; rows paged within the refresh budget |
| CRM / leads | ~85% | Income needs a sales join; no `updatedSince` on sales/calls/subscriptions; lists capped with a `truncated` flag |
| Tracking in/out | ~95% | Async writes; caller-managed idempotency |
| Live updating | ~60% | Webhooks exist but the template still polls; reports are async |
| Scale Advisor | ~70% | The curve tool answers (since late Sep); no account-level ceiling, no thin-data flag |

## 17. What the dashboard does with all this (as of 0.2.0)

- Snapshot carries `templateVersion`, `schema`, and `warnings[]` with
  `kind: unsupported | rate_limited | error | truncated | time budget`;
  `crm.sync.truncated`, `crm.sync.stale`, `sourcesTruncated` and
  `ranges[key].skipped` say exactly which part is partial. The CRM shows
  "1,000+" when a list hit its cap.
- Attribution rows are paginated within the refresh budget; unfetched
  ranges are marked `skipped` rather than reported as zero.
- 401 marks the key invalid; 403 does not. 429 backs off with
  `Retry-After`.
- Incremental lead sync runs when the previous window overlaps the new
  one (the daily cron included); sales, calls and subscriptions are still
  full pulls.
- CRM-only accounts (no reportable ad account) build with an empty report
  and a warning instead of failing.
- IANA timezones and ISO datetimes with offset on every date parameter;
  legacy `EEE MMM dd …` dates parsed; `leadStage` validated on save.
- Scale Advisor parses the documented curve shape and surfaces a failing tool (404 until late September) as an error card.
- `/api/health` returns `templateVersion` and `missingTools` (tools the
  account's `tools/list` lacks); refresh and setup failures are logged as
  JSON event lines in the Vercel runtime logs (no keys, no emails).

`scripts/mock-mcp.mjs` + `scripts/pipeline-test.mjs` (in `npm run check`)
exercise the pipeline against a mock of this surface: settings on the
wire, `parentId` linkage, pagination and truncation, 429 back-off,
incremental merge across days, the documented curve shape, and the health
tools.

## A note on the exploration account

$545,266 of $560,292 total revenue on the original exploration account sat
under "No Source Data", and Meta showed $4,129.58 cost against $0.00
attributed revenue. Revenue and ROAS columns read zero there by design.
Validate a pipeline against **Cost, Clicks, Impressions, CTR, CPM, Leads,
CPL and Reported Result** first — the metrics that carry data on most
accounts — before debugging revenue.

## Three API changes that would unlock the next features

Scoping an analytics tab and a split-testing tab reduced every blocker to
the same root causes: organic/custom sources are unreportable on
`/attribution`, there is no aggregate click query, and attribution is
credit-assignment only. HYROS already stores the data at the needed grain
(`hyros_get_lead_clicks` returns URL-stamped clicks per lead;
`hyros_create_click` accepts a `sessionId`; the leads UI shows tracked
URLs), so these are query work, not tracking changes:

1. **Platform-agnostic report level** — accept plain source tags in `ids`
   (the ROAS and curve tools already use `ad | source_link | campaign |
   account`).
2. **Aggregate clicks endpoint** — a date-range query with
   `groupBy: url | source | day`: top pages, entry pages, traffic
   timelines, and the denominator every conversion rate needs.
3. **`attributionMode: CREDIT | TOUCHED`** — "conversions among leads whose
   journey touched source X"; the `JOURNEY` report family is the closest
   thing today, at 30 paths per call.

Bounce rate, visit duration, views per visit and exit pages need the
tracking script to emit session structure — a product decision, pitched
separately.
