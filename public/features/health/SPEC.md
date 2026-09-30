# Tracking Health — feature spec

**id** `health` · **mode** both (live + demo) · **version** 1.1.0

## Purpose
Answer "is tracking actually working?" with HYROS's own checks: the
universal script's presence on each verified domain, and whether Google ad
links carry the tracking parameters attribution needs — and, just as
important, say plainly when a check could not run. A "—" in a tile is
never left unexplained.

## Data (server step, `server.js`)
Three independent checks, run **cheapest first** so a slow HYROS answer can
never starve the others:

1. `hyros_get_domains` → verified domains (first 20). The REST side
   documents `GET /domains` → `string[]`; the tool reply is read as a bare
   array or `{ result | domains: [string | { domain | name | url }] }`.
2. If any ad account is `GOOGLE*`:
   `hyros_check_tracking_parameters_for_integrations { request: { type } }`
   for `SEARCH` and `PERFORMANCE_MAX` (rows capped at 50), one call each,
   sequential (one rate limit per account).
3. **Last**, `hyros_assert_script_presence_on_domain { request: { domains: [url…] } }`.
   The verified domains HYROS returns are the **tracking domains** — the
   CNAMEs a customer points at HYROS (`data.shop.com`). The universal
   script lives on the site itself, so the check fetches the site behind
   each tracking domain: the registrable apex (`https://shop.com/`, second-
   level suffixes like `co.uk` kept) first, then its `www.` variant,
   in batches of 3 URLs per call — the live MCP rejects more ("The maximum
   number of domains to be provided for inspection is 3", undocumented,
   observed 2026-09-21). The block records the mapping in
   `sites: [{ url, trackingDomain }]` (always present; a stale carry-forward
   keeps the previous mapping) and the view shows the tracking
   domain under each site row. Apex and www of one site are committed
   together; at most 12 URLs in total (`MAX_SITE_URLS`), so with more than
   6 tracking domains the later sites are not checked and the check reason
   says so.
   Legacy line for reference: `hyros_assert_script_presence_on_domain { domains: [url…] }`
   for up to 3 URLs → expected `{ url: 'SCRIPT_FOUND' | 'SCRIPT_NOT_FOUND' }`.
   HYROS fetches every domain live for this one, which regularly takes
   longer than the 15 s per-call contract — see "Timeouts".

**Undocumented shapes.** Neither the request nor the response shape of
tools 2 and 3 is documented (mcp.txt lists the tools by name only; see
FINDINGS.md "Undocumented behaviour the app relies on"). The argument
shapes above are the app's guess, and the replies are read tolerantly: a
script-check reply that is a `{ url: status }` map, a `{ result: map }`
envelope, or an array of `{ url | domain, status | result | present }` is
accepted; anything else makes the check **failed** with reason
`unexpected reply shape` instead of an empty result. Parameter rows are
taken from a bare array, `result`, `ads`, or a single object; the view
flags a row when `valid === false`, `missing` exists, `ok === false`, or
the row text mentions missing/invalid.

### Timeouts
- Checks 1 and 2 use the default per-call timeout (`ctx.timeouts?.default`,
  else 15 s; never more than 15 s).
- Check 3 uses the runner's **slow lane**: `ctx.timeouts?.slow` (45 s when
  the runner offers `timeouts` without `slow`), capped at
  `ctx.timeLeft() - 2000` so it always ends inside the step. If fewer than
  8 s remain the check is **skipped** (`time budget`) rather than started.
  A runner that does not expose `ctx.timeouts` has not declared a slow
  lane, so the check stays on the 15 s contract there (the conformance
  stub is such a runner).
- A timeout is recorded as `status: 'failed'` with reason
  `HYROS did not answer within Ns (the check fetches every domain live)`.

### Budget
`ctx.timeLeft()` is checked before the FIRST call (zero calls on a spent
budget: the previous block is kept marked `stale`, or a bare `{ skipped }`
is returned) and before every call after it; a check that cannot start is
`skipped` with reason `time budget`. No check ever fails the refresh.

### Stale carry-forward (script check only)
When the script check is skipped or fails this refresh and `previous` holds
a completed one (its `checks.script.status` is `ok`/`empty`, or it was
itself carried forward, or it predates `checks` and has results), the
previous `scripts` map is copied into the new block and the check is
marked `stale: true` with `checkedAt` = the refresh that produced those
results (kept through repeated carry-forwards). The block itself stays
fresh (new `checkedAt`, no block-level `stale`). The panel shows the last
known per-URL state with a "previous check · <date>" pill, under the
status line saying why this refresh did not replace it.

### Visits cross-check (after the script check)
The script check reads the raw page, so a script injected at runtime by a
site builder reads `SCRIPT_NOT_FOUND` on pages HYROS is tracking, and slow
sites answer `TIMEOUT_ERROR` (beta account, 2026-09-28). When any URL came
back without the script, `hyros_get_lead_clicks { request: { leadIds, fromDate,
pageSize: 250 } }` reads the clicks of the 50 CRM leads with the latest
activity (last source date, else join date) over the last 7 days, up to 4
pages; their page hosts (without `www`) are stored as `visitedHosts`, and
a visit on a subdomain (`shop.example.com`) counts for its site. The
view shows a site without the script but with visits as amber "not detected ·
visits tracked" and counts it as working; a site whose every variant timed
out is amber "couldn't check (timeout)" and is left out of the count; the
"Script present" tile is green only when every checked site has the script,
neutral when a site is only confirmed by visits or could not be checked
(`—` when no site could be checked), terracotta when one has neither. Only a
site with no script and no visits is terracotta "script not found". Skipped
when every URL has the script or there are no leads; a failure is recorded
in `checks.visits`, never in `errors`.

## Block shape (`snapshot.health`)
```json
{ "checkedAt": "ISO",
  "domains": ["example.com"],
  "scripts": { "https://example.com/": "SCRIPT_FOUND" },
  "visitedHosts": ["example.com"],
  "trackingParams": [{ "type": "SEARCH", "rows": [{ "adName": "", "valid": true, "missing": ["gclid"] }] }],
  "errors": ["script: HYROS did not answer within 45s (the check fetches every domain live)"],
  "checks": {
    "domains": { "status": "ok", "ms": 412 },
    "params":  { "status": "ok", "ms": 1730, "channels": { "SEARCH": "ok", "PERFORMANCE_MAX": "skipped" } },
    "script":  { "status": "failed", "reason": "…", "ms": 45001, "stale": true, "checkedAt": "ISO of the results shown" },
    "visits":  { "status": "ok", "ms": 640 }
  },
  "stale": "optional true", "skipped": "optional" }
```
`checks.<name>` is `{ status, reason?, ms? }` with
`status ∈ ok | empty | skipped | failed`:
- `ok` — ran and returned something; `empty` — ran and found nothing;
- `skipped` — not started; `reason` ∈ `time budget` · `no verified domains`
  · `domains check failed` · `no Google ad accounts connected`;
- `failed` — started and errored; `reason` is the tool's message (or the
  timeout / unexpected-shape text above).
- `ms` — wall time of the call(s), when one was made.
- `params` adds `channels: { <type>: status }` per Google channel; its own
  status is `ok` if any channel returned rows, else `empty` if any ran,
  else `failed` (reason joins the channel errors), else `skipped`.
- `script` adds `stale: true` + `checkedAt` when its results were carried
  forward (above).

`errors[]` is kept for older readers: one string per **failed** check
(`domains: …`, `params SEARCH: …`, `script: …`). Skips are not errors.
The parameter rows' shape is whatever HYROS returns (see above).

## View states
- **fresh** — the block above; every tile reads its check:
  - *Script present*: `N / M` when `checks.script` is `ok`; otherwise `—`
    with sub `skipped: time budget` / `failed: <short reason>` /
    `no verified domains`.
  - *Ads missing tracking params*: the flagged count when `ok`, sub
    `checked: SEARCH, PERFORMANCE_MAX` (or per-channel outcomes when they
    differ); otherwise `—` with the same sub pattern, or
    `no Google ad accounts`.
  - *Check errors*: the count; sub = the first error, short. A full-size
    **Check errors** panel lists every error with a bad pill per check
    name. A **Checks this refresh** panel shows each check's status, reason
    and duration.
  - *Script presence* panel: rows per URL when available (carried-forward
    rows wear a `previous check · <date>` pill); otherwise one status line:
    "Skipped this refresh (time budget) — press Refresh again" /
    "Check failed: <reason>" / "No verified domains on this account — add
    one in HYROS".
  - *Ad link tracking parameters* panel: rows when available; "No ads
    reported by the check in the last hour" **only** when
    `checks.params.status === 'empty'`; "Skipped this refresh (time
    budget)" when skipped; "Check failed: <reason>" when failed; "No Google
    ad accounts connected — nothing to check" only when `snapshot.adAccounts`
    has no `GOOGLE*` account.
- **stale** — `{ ...data, stale: true, skipped: 'time budget' }`: the note
  says "Skipped this refresh (…) — showing the previous check from
  `fmt.datetime(checkedAt)`".
- **bare skipped** — `{ skipped }`: "nothing was checked yet. Hit Refresh
  again"; every KPI shows "—" / "not checked" and the panels say "Not
  checked this refresh".
- **error** — `{ error }`: the message in the note bar.
- **blocks from before `checks` existed** render with checks inferred from
  the data and the `errors` strings (one release of compatibility).
No state invents a green result.

## Also shown
Account & access — ad accounts, `managedBy` / `clients` from
`snapshot.account`, and the account's default attribution window. An ad
account that appears in `snapshot.warnings[]` (`{ adAccountId, name, type,
level, error, kind }`, kind ∈ unsupported | rate_limited | error |
truncated | time budget) gets a pill with the kind (e.g. "skipped:
unsupported") and the message as its title.

## Porting notes
Another app needs the block above; `view.js` + `style.css` reuse
unchanged. HYROS-specific: the three tools, the `{ domains }` /
`{ request: { type } }` argument guesses, `snapshot.warnings` (core
snapshot) for the access pills, and the runner's optional `ctx.timeouts`
(FEATURES.md) for the slow script check — without it the check runs on the
15 s contract and says so when it times out.

## Open limitations
- Tools 2 and 3 have no documented contract; a captured live payload is
  the only way to confirm the shapes (until then the "unexpected reply
  shape" failure is the honest outcome of a mismatch).
- `hyros_check_tracking_parameters_for_integrations` is documented as
  covering "active integrations" — the app assumes a `type` filter and
  only checks the two Google channels; other integrations are not checked.
- The script check's duration depends on how many domains HYROS fetches
  and how fast they answer; 45 s is a ceiling, not a guarantee. When it
  still times out the tile says so and the previous results stay visible.
- The demo block fakes one missing script and one ad missing `gclid`, with
  every check `ok`; it is illustrative, not a captured result.
