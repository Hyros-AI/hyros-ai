/**
 * Snapshot builder — the whole "via the MCP" pipeline.
 *
 * Everything the dashboard renders is produced here, from MCP tool calls only.
 * The output is one flat JSON document; the front end never talks to HYROS.
 *
 * The level model mirrors HYROS's own (SourceNamingUtils.ts). For Meta:
 *   AD_ACCOUNT      -> "Account"
 *   SOURCE_CATEGORY -> "Campaign"     <- NOT a Meta campaign object
 *   SOURCE_LINK     -> "Ad Set"       <- the MCP's FACEBOOK_ADSET level
 *   SOURCE_LINK_AD  -> "Ad"           <- the MCP's FACEBOOK_AD level
 *
 * The MCP exposes no campaign/traffic-source grouping, so those two levels are
 * rolled up from the ad-set base table joined to `hyros_get_sources`, which
 * carries `category` and `trafficSource` per source. That reproduces the real
 * report's Campaign tab exactly.
 */

import { callTool, callToolPaged, callToolPagedInfo } from './_mcp.js';
import { parseTimezone, ymdInTz, addDays, dayStart, dayEnd, parseHyrosDate, offsetSuffix } from './_dates.js';
import { runFeatureSteps } from './_features.js';
import { priceOf } from './_price.js';
import { TEMPLATE_VERSION } from './_version.js';
import { REFRESH_BUDGET_MS, planBudget, crmMinMs, clampTimeout } from './_budget.js';
import { CATALOG, derive, aggregate, rollup } from '../public/shared/metrics.js';

/** A build with no explicit budget gets the whole refresh budget (api/_budget.js). */
export const DEFAULT_BUDGET_MS = REFRESH_BUDGET_MS;

// Request the ENTIRE catalog: the `fields` param drives computation (verified
// empirically — requested fields populate, unrequested come back null), and the
// response carries every key either way, so the marginal wire cost is zero.
// This is what makes column-adding instant client-side instead of per-refresh.
const REPORT_FIELDS = ['NAME', 'PARENT_NAME', ...CATALOG.map((c) => c.f)];

/* ---------------- date helpers (account timezone) ---------------- */

/** Ranges are YYYY-MM-DD in the account timezone ("-05:00", "UTC", "America/New_York", … — see _dates.js). */
export function buildRanges(now, tz) {
  const today = ymdInTz(now, tz);
  return {
    today:     { label: 'Today',        start: today,             end: today },
    yesterday: { label: 'Yesterday',    start: addDays(today, -1), end: addDays(today, -1) },
    '7d':      { label: 'Last 7 days',  start: addDays(today, -6), end: today },
    '30d':     { label: 'Last 30 days', start: addDays(today, -29), end: today },
  };
}

/* ---------------- normalisation ---------------- */

/**
 * Keep every catalog metric the API populated (null = not computed, dropped),
 * guarantee the core additive base exists so derived math is stable, then
 * re-derive. Null-stripping keeps the stored snapshot far smaller than the
 * wire payload even with the full catalog requested.
 */
const CORE_ZERO = ['cost', 'revenue', 'totalRevenue', 'sales', 'leads',
  'calls', 'clicks', 'impressions', 'reported'];

function normalizeRow(raw) {
  const row = {
    id: String(raw.id ?? ''),
    name: raw.name || null,
    parentName: raw.parentName || null,
    // Ad-level rows carry the parent source id since the Sept 2026 MCP
    // upgrade — the handle that makes ad-under-ad-set linkage exact.
    parentId: raw.parentId != null ? String(raw.parentId) : null,
  };
  for (const entry of CATALOG) {
    const v = entry.k === 'reported' ? raw.reportedResult : raw[entry.k];
    if (v !== null && v !== undefined) row[entry.k] = v;
  }
  for (const k of CORE_ZERO) row[k] = row[k] ?? 0;
  return derive(row);
}

/**
 * Report levels per ad-account type, named as the MCP's `level` enum names
 * them (api-docs.hyros.com, GET /attribution). `adset` is the SOURCE_LINK
 * level every platform has; `ad` exists only where the platform exposes one.
 * Classic Google and LinkedIn are tracked at campaign level, Google V2 stops
 * at ad group, Snapchat calls its ad set an "ad squad". Types missing here
 * (REDDIT, APPLOVIN, WHOP_ADS, …) have no attribution level and are skipped.
 */
export const LEVELS_BY_TYPE = {
  FACEBOOK:  { adset: 'FACEBOOK_ADSET',    ad: 'FACEBOOK_AD' },
  GOOGLE:    { adset: 'GOOGLE_CAMPAIGN',   ad: 'GOOGLE_AD' },
  GOOGLE_V2: { adset: 'GOOGLE_V2_ADGROUP', ad: null },
  TIKTOK:    { adset: 'TIKTOK_ADGROUP',    ad: 'TIKTOK_AD' },
  // The live MCP (mcp.hyros.com) names this level SNAPCHAT_ADSET; the REST docs say snapchat_adsquad. Its accepted list (from the error text, 2026-09-21): GOOGLE_CAMPAIGN, GOOGLE_ADGROUP, GOOGLE_AD, GOOGLE_KEYWORD, FACEBOOK_ADSET, FACEBOOK_CAMPAIGN, TIKTOK_ADGROUP, SNAPCHAT_ADSET, PINTEREST_ADGROUP, TWITTER_ADGROUP, BING_ADGROUP, FACEBOOK_AD, TIKTOK_AD, SNAPCHAT_AD, PINTEREST_AD, TWITTER_AD, BING_AD, LINKEDIN_CAMPAIGN, LINKEDIN_AD, GOOGLE_V2_KEYWORD, GOOGLE_V2_ADGROUP, GOOGLE_V2_AD, GOOGLE_V2_CAMPAIGN. Accepted is not the same as supported per integration (classic GOOGLE rejects GOOGLE_ADGROUP), so the single-level rows stay.
  SNAPCHAT:  { adset: 'SNAPCHAT_ADSET',     ad: 'SNAPCHAT_AD' },
  PINTEREST: { adset: 'PINTEREST_ADGROUP', ad: 'PINTEREST_AD' },
  TWITTER:   { adset: 'TWITTER_ADGROUP',   ad: null },
  BING:      { adset: 'BING_ADGROUP',      ad: 'BING_AD' },
  LINKEDIN:  { adset: 'LINKEDIN_CAMPAIGN', ad: null },
};

/* ---------------- report settings (saved via /api/prefs) ---------------- */

export const REPORT_MODELS = ['LAST_CLICK', 'FIRST_CLICK', 'SCIENTIFIC'];

/**
 * Keep only the saved lead stages the account really has (matched
 * case-insensitively, stored with the account's spelling); the rest are
 * reported through `warn` so a typo cannot fail every level.
 */
export function validateLeadStage(settings, stages, warn = () => {}) {
  const byLower = new Map((stages || []).map((s) => [String(s?.name || '').toLowerCase(), s.name]));
  const kept = [];
  const dropped = [];
  for (const name of settings.leadStage) {
    const hit = byLower.get(name.toLowerCase());
    if (!hit) dropped.push(name);
    else if (!kept.includes(hit)) kept.push(hit);
  }
  if (dropped.length) {
    warn(null, 'leadStage', `lead stage${dropped.length > 1 ? 's' : ''} ${dropped.map((d) => `"${d}"`).join(', ')} not in the account's stages (${[...byLower.values()].join(', ') || 'none'}) — ignored`, 'error');
  }
  return { ...settings, leadStage: kept };
}

/** Validate/normalize the saved report settings; unknown values fall to defaults. */
export function normalizeSettings(raw = {}) {
  const model = REPORT_MODELS.includes(raw?.model) ? raw.model
    : (REPORT_MODELS.includes(process.env.HYROS_ATTRIBUTION_MODEL) ? process.env.HYROS_ATTRIBUTION_MODEL : 'LAST_CLICK');
  const windowDays = Number.isInteger(raw?.windowDays) && raw.windowDays >= 0 && raw.windowDays <= 365
    ? raw.windowDays : 0;
  const leadStage = Array.isArray(raw?.leadStage)
    ? raw.leadStage.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 10)
    : [];
  return { model, windowDays, leadStage };
}

/** Attribution rows per level per range: 8 pages × 250 before the newest-N warning. */
const ATTRIBUTION_MAX_PAGES = 8;
/** Per-call timeout for the attribution report (one page; the core's share of the budget bounds the whole pull). */
export const ATTRIBUTION_TIMEOUT_MS = 15000;      // floor: what a 120 s cron share can afford
export const ATTRIBUTION_TIMEOUT_MAX_MS = 25000;  // cap on a full 290 s refresh (a large ad account was seen needing > 15 s)
/**
 * Page caps are bounded by the deadline, not by a small number: 40 × 250 =
 * 10,000 rows per list. `truncated` is only ever true when the API still
 * had a nextPageId at the cap, the cursor expired, or the deadline cut in.
 */
const SOURCES_MAX_PAGES = 40;
const CRM_MAX_PAGES = 40;

/**
 * One level of one ad account for one range, paged to completion (or to the
 * page cap / the deadline). Returns { rows, truncated, error? } so the
 * caller can record "showing newest N rows" instead of presenting a partial
 * table as complete.
 */
async function fetchLevel(level, adAccountId, range, settings, { deadline = null, timeoutMs, tz = 'UTC', now = new Date() } = {}) {
  const request = {
    attributionModel: settings.model,
    startDate: dayStart(range.start, tz),
    // Today ends now: the report rejects an endDate in the future.
    endDate: dayEnd(range.end, tz, now),
    level,
    ids: [adAccountId],
    isAdAccountId: true,
    timeGroupingOption: 'SOURCE_LINK',
    pageSize: 250,
    // Newest sources first: on accounts with many inactive sources the
    // oldest-first default fills the page with ads that no longer run.
    newestFirst: true,
    // ALL_SOURCES + report visibility = what the account's own report screens use.
    sourceConfiguration: 'ALL_SOURCES',
    fields: REPORT_FIELDS,
  };
  // Per-query attribution window (LAST_CLICK only, per the API).
  if (settings.windowDays > 0 && settings.model === 'LAST_CLICK') {
    request.windowAttributionDaysRange = settings.windowDays;
  }
  // Funnel-outcome ranking: narrow leads/sales/revenue to leads in these stages.
  if (settings.leadStage.length) request.leadStage = settings.leadStage;

  const page = await callToolPagedInfo('hyros_get_attribution_report', { request },
    { maxPages: ATTRIBUTION_MAX_PAGES, pageSize: 250, deadline, timeoutMs });
  return { ...page, rows: page.rows.map(normalizeRow) };
}

/* ---------------- level assembly ---------------- */

/**
 * Build all five report levels for one range from the ad-set + ad base tables.
 * `sourceById` maps an ad-set (source-link) id to its source metadata.
 */
export function buildLevels({ adsetRows, adRows, sourceById, adAccountName }) {
  // Ad-set rows sometimes come back with a null name; resolve from the source
  // table, and carry the source TAG — it's the handle the lead-drill uses
  // (get_leads({tags:[...]}) is a server-side cohort query).
  const adsets = adsetRows.map((r) => ({
    ...r,
    name: r.name || sourceById.get(r.id)?.name || r.id,
    tag: sourceById.get(r.id)?.tag || null,
    _category: sourceById.get(r.id)?.category || 'Uncategorised',
    _traffic: sourceById.get(r.id)?.trafficSource || 'unknown',
    _account: sourceById.get(r.id)?.adAccountId || null,
  }));

  const ads = adRows.map((r) => ({ ...r, name: r.name || r.id }));

  // Rolled-up rows drill with the union of their members' tags (the tags
  // filter on get_leads is OR semantics).
  const withTags = (rows, keyOf) => rows.map((row) => ({
    ...row,
    tags: [...new Set(adsets.filter((a) => keyOf(a) === row.id && a.tag).map((a) => a.tag))].slice(0, 40),
  }));

  return {
    traffic:  withTags(rollup(adsets, (r) => r._traffic, (id) => id), (a) => a._traffic),
    account:  withTags(rollup(adsets, (r) => r._account, (id) => adAccountName.get(id) || id || 'Unknown'), (a) => a._account),
    campaign: withTags(rollup(adsets, (r) => r._category, (id) => id), (a) => a._category),
    adset:    adsets,
    ad:       ads,
  };
}

/* ---------------- CRM ---------------- */

/** Flatten the source object the leads tool returns; `iso` normalises its date. */
function flattenSource(src, iso = (v) => v || null) {
  if (!src) return null;
  return {
    name: src.name || null,
    tag: src.tag || null,
    organic: Boolean(src.organic),
    trafficSource: src.trafficSource?.name || null,
    category: src.category?.name || null,
    clickDate: iso(src.clickDate),
  };
}


/**
 * Incremental lead sync (MCP upgrade: updatedFromDate/updatedToDate). Given
 * the previous snapshot's leads and the leads changed since it was built,
 * produce the current window: changed rows replace their older copies, rows
 * that joined before the window drop off. Exported for the self-test.
 */
export function mergeLeads(previousLeads, changedLeads, leadsFrom) {
  const byId = new Map();
  for (const l of previousLeads || []) if (l?.id) byId.set(l.id, l);
  for (const l of changedLeads || []) if (l?.id) byId.set(l.id, l);
  const floor = `${leadsFrom}T00:00:00`;
  return [...byId.values()]
    // A lead HYROS merged into another comes back with `originLead` (the
    // Lead schema); its own row is gone from the account, so drop it here.
    // Permanently DELETED leads carry no marker in the API — they simply
    // stop being returned — so they linger until they leave the window or
    // a full pull (previous older than 7 days) rebuilds the set.
    .filter((l) => !l.mergedInto)
    .filter((l) => !l.joined || String(l.joined).slice(0, 19) >= floor)
    .sort((a, b) => String(b.joined || '').localeCompare(String(a.joined || '')));
}

/** Previous window overlaps the new one and its real sync is recent enough to build on. */
function canSyncIncrementally({ previous, prevAt, leadsFrom, leadsTo }) {
  const win = previous?.crm?.window;
  if (!Array.isArray(previous?.crm?.leads) || !win?.from || !win?.to || !prevAt) return false;
  const overlaps = win.from <= leadsTo && win.to >= leadsFrom;
  const recent = prevAt <= leadsTo && prevAt >= addDays(leadsTo, -INCREMENTAL_MAX_AGE_DAYS);
  return overlaps && recent;
}

/** A previous sync older than this rebuilds the lead set from scratch. */
const INCREMENTAL_MAX_AGE_DAYS = 7;

async function buildCrm({ leadsFrom, leadsTo, previous = null, now = new Date(), deadline = null, tz = 'UTC', stages = [] }) {
  // Incremental: when the previous snapshot is recent enough, pull only the
  // leads updated since it was built (a lead's lastUpdatedDate moves on
  // creation too, so new joins are included). Sales/calls/subscriptions have
  // no updated-since filter yet and are pulled in full. A stale (reused) CRM
  // keeps sync.syncedAt from the build that really pulled, so that is the base.
  const prevLeads = previous?.crm?.leads;
  const prevSynced = previous?.crm?.sync?.syncedAt || previous?.generatedAt;
  const prevAt = prevSynced ? String(prevSynced).slice(0, 10) : null;
  // The daily cron moves the 30-day window by a day, so windows are compared
  // by overlap, not equality; the pull starts a day before the last real sync.
  const incremental = canSyncIncrementally({ previous, prevAt, leadsFrom, leadsTo });
  const from = dayStart(leadsFrom, tz);
  const to = dayEnd(leadsTo, tz, now);
  const leadsRequest = incremental
    ? { updatedFromDate: dayStart(addDays(prevAt, -1), tz), updatedToDate: to }
    : { fromDate: from, toDate: to };

  // The four lists page in parallel up to CRM_MAX_PAGES (10,000 rows each)
  // and every one stops at `deadline` (the CRM's reservation); the cap, an
  // expired cursor or the deadline is reported in sync.truncated rather
  // than passed off as the whole month.
  const paged = { pageSize: 250, deadline, maxPages: CRM_MAX_PAGES };
  const [leadsPage, salesPage, callsPage, subsPage] = await Promise.all([
    callToolPagedInfo('hyros_get_leads', { request: leadsRequest }, paged),
    callToolPagedInfo('hyros_get_sales', { request: { fromDate: from, toDate: to } }, paged),
    callToolPagedInfo('hyros_get_calls', { request: { fromDate: from, toDate: to } }, paged),
    callToolPagedInfo('hyros_get_subscriptions', { request: { fromDate: from, toDate: to } }, paged),
  ]);
  const leadsRaw = leadsPage.rows;
  const salesRaw = salesPage.rows;
  const callsRaw = callsPage.rows;
  const subsRaw = subsPage.rows;
  const truncated = {
    // A merge on top of a truncated base is still truncated.
    leads: leadsPage.truncated || Boolean(incremental && previous?.crm?.sync?.truncated?.leads),
    sales: salesPage.truncated, calls: callsPage.truncated, subscriptions: subsPage.truncated,
  };
  const truncationErrors = Object.entries({ leads: leadsPage, sales: salesPage, calls: callsPage, subscriptions: subsPage })
    .filter(([, p]) => p.truncated)
    .map(([list, p]) => `${list}: showing ${p.rows.length} rows${p.error ? ` (${p.error})` : ' (page cap)'}`);

  // Response dates: leads are ISO, sales/calls/subscriptions use the legacy
  // `EEE MMM dd HH:mm:ss zzz yyyy` form (docs); store ISO everywhere.
  const iso = (v) => parseHyrosDate(v, offsetSuffix(tz));

  // Income per lead: the lead object has no revenue field, so join sales by
  // email. Amounts are summed as reported (usdPrice when present, else the
  // documented price object) — a mixed-currency account sums face values.
  const incomeByEmail = new Map();
  for (const sale of salesRaw) {
    const email = (sale.lead?.email || '').toLowerCase();
    if (!email) continue;
    incomeByEmail.set(email, (incomeByEmail.get(email) || 0) + priceOf(sale).amount);
  }

  const fetchedLeads = leadsRaw.map((l) => {
    const first = flattenSource(l.firstSource, iso);
    const last = flattenSource(l.lastSource, iso);
    return {
      id: l.id,
      email: l.email || '',
      name: [l.firstName, l.lastName].filter(Boolean).join(' ').trim() || null,
      joined: iso(l.creationDate),
      updated: iso(l.lastUpdatedDate),
      stage: l.currentStage?.name || null,
      stageDate: iso(l.currentStage?.date),
      consent: l.adOptimizationConsent || 'UNSPECIFIED',
      tags: l.tags || [],
      phones: l.phoneNumbers || [],
      firstSource: first,
      lastSource: last,
      lastSourceDate: last?.clickDate || null,
      hasAttribution: Boolean(first || last),
      // Set when HYROS merged this lead into another (Lead.originLead).
      mergedInto: l.originLead?.id || l.originLead?.email || null,
    };
  });

  const leads = (incremental ? mergeLeads(prevLeads, fetchedLeads, leadsFrom) : fetchedLeads.filter((l) => !l.mergedInto))
    // Income is re-joined from the fresh sales pull for every lead, merged or not.
    .map(({ mergedInto, ...l }) => ({ ...l, income: incomeByEmail.get((l.email || '').toLowerCase()) || 0 }));

  const leadName = (l) =>
    [l?.firstName, l?.lastName].filter(Boolean).join(' ').trim() || null;
  const srcName = (src) => src?.name || null;
  const srcAd = (src) => src?.sourceLinkAd?.name || null;

  const sales = salesRaw.map((s) => ({
    id: s.id,
    email: s.lead?.email || '',
    leadName: leadName(s.lead),
    date: iso(s.creationDate),
    ...priceOf(s),
    product: s.product?.name || null,
    recurring: Boolean(s.recurring),
    refunded: Boolean(s.refundDate),
    refundDate: iso(s.refundDate),
    firstSource: srcName(s.firstSource),
    lastSource: srcName(s.lastSource),
  }));

  // Calls carry FULL attribution on the call object itself (source, category
  // and the specific ad) — richer than the lead row.
  const calls = callsRaw.map((c) => ({
    id: c.id,
    email: c.lead?.email || '',
    leadName: leadName(c.lead),
    date: iso(c.creationDate),
    name: c.name || c.tag || null,
    state: c.state || (c.qualified ? 'QUALIFIED' : 'UNQUALIFIED'),
    qualified: Boolean(c.qualified),
    firstSource: srcName(c.firstSource),
    ad: srcAd(c.firstSource) || srcAd(c.lastSource),
    lastSource: srcName(c.lastSource),
  }));

  const subscriptions = subsRaw.map((x) => ({
    id: x.id || x.subscriptionId || null,
    email: x.lead?.email || x.email || '',
    leadName: leadName(x.lead),
    date: iso(x.startDate || x.creationDate),
    endDate: iso(x.endDate),
    name: x.name || x.planId || null,
    price: priceOf(x).amount,
    currency: priceOf(x).currency,
    periodicity: x.periodicity || null,
    status: x.status || null,
    provider: x.provider?.integration?.name || x.provider || null,
  }));

  const block = {
    leads,
    sales,
    calls,
    subscriptions,
    stages: stages.map((s) => ({ name: s.name, amount: s.amount })),
    window: { from: leadsFrom, to: leadsTo },
    sync: { incremental, leadsFetched: fetchedLeads.length, syncedAt: now.toISOString(), truncated },
    totals: crmTotals(leads, calls, subscriptions),
  };
  // `notes` are the truncation reasons for snapshot.warnings (kind 'truncated').
  return { block, notes: truncationErrors };
}

function crmTotals(leads, calls, subscriptions) {
  return {
    leads: leads.length,
    attributed: leads.filter((l) => l.hasAttribution).length,
    customers: leads.filter((l) => l.stage === 'Customer').length,
    income: leads.reduce((sum, l) => sum + l.income, 0),
    calls: calls.length,
    qualifiedCalls: calls.filter((c) => c.qualified).length,
    subscriptions: subscriptions.length,
  };
}

/** Upstash refuses any request over 10 MB; the snapshot is written in one SET. */
export const SNAPSHOT_MAX_BYTES = 9 * 1024 * 1024;
const CRM_LISTS = ['leads', 'sales', 'calls', 'subscriptions'];

/**
 * Trim a snapshot that would not fit the store's request limit: the longest
 * CRM list loses its oldest rows (lists are newest-first) until the JSON fits,
 * the trimmed lists are flagged `truncated`, totals are recomputed and a
 * warning says what was kept. Below the limit the snapshot is returned as is.
 */
export function fitSnapshot(snapshot, maxBytes = SNAPSHOT_MAX_BYTES) {
  const size = (o) => Buffer.byteLength(JSON.stringify(o));
  if (!snapshot?.crm || size(snapshot) <= maxBytes) return snapshot;
  const crm = { ...snapshot.crm, sync: { ...(snapshot.crm.sync || {}), truncated: { ...(snapshot.crm.sync?.truncated || {}) } } };
  const out = { ...snapshot, crm, warnings: [...(snapshot.warnings || [])] };
  const kept = {};
  for (let guard = 0; guard < 40; guard += 1) {
    const bytes = size(out);
    if (bytes <= maxBytes) break;
    const list = CRM_LISTS.filter((k) => Array.isArray(crm[k]) && crm[k].length).sort((a, b) => crm[b].length - crm[a].length)[0];
    if (!list) break;
    const keep = Math.floor(crm[list].length * Math.min(0.9, maxBytes / bytes));
    crm[list] = crm[list].slice(0, keep);
    crm.sync.truncated[list] = true;
    kept[list] = keep;
  }
  crm.totals = crmTotals(crm.leads || [], crm.calls || [], crm.subscriptions || []);
  const summary = Object.entries(kept).map(([k, n]) => `${n} ${k}`).join(', ');
  out.warnings.push({ adAccountId: null, name: null, type: null, level: 'crm', error: `snapshot over ${Math.round(maxBytes / 1024 / 1024)} MB (the store's request limit): kept the newest ${summary}`, kind: 'truncated' });
  return out;
}

/* ---------------- Scale Advisor: marginal CAC curves ---------------- */


/* Scale Advisor / Tracking Health moved to public/features/<id>/server.js —
 * every feature's server step runs through api/_features.js runFeatureSteps(). */

/* ---------------- top level ---------------- */

export async function buildSnapshot({
  now = new Date(), onProgress = () => {}, prefs = null, previous = null, budgetMs = DEFAULT_BUDGET_MS,
} = {}) {
  const started = Date.now();
  // Proportional reservations (api/_budget.js): the core (account, sources,
  // attribution ranges) may use up to `coreMs`, the CRM pull the next
  // `crmMs`, and the feature steps get the rest plus whatever the two before
  // them did not spend. A slow attribution pull therefore never starves the
  // CRM or Tracking Health.
  const plan = planBudget(budgetMs);
  const deadline = started + plan.budgetMs;
  const coreDeadline = started + plan.coreMs;
  const crmDeadline = coreDeadline + plan.crmMs;
  const secs = (ms) => `${Math.floor(ms / 1000)}s`;
  onProgress(`budget ${secs(plan.budgetMs)}: core <= ${secs(plan.coreMs)}, crm <= ${secs(plan.crmMs)}, features >= ${secs(plan.featuresMs)}`);
  const saved = normalizeSettings(prefs?.settings);
  const model = saved.model;

  onProgress('account');
  const user = await callTool('hyros_get_user_info', {});
  const tz = user?.userProfile?.timezone || '+00:00';
  const acctSummary = (list) => (Array.isArray(list) ? list : []).map((a) => ({
    accountId: a.accountId || null, email: a.email || null, company: a.companyName || null,
    status: a.status || null,
  }));

  onProgress('ad accounts');
  const accountsPage = await callToolPagedInfo('hyros_get_ad_accounts', { request: {} }, { maxPages: 4, pageSize: 250 });
  let accounts = accountsPage.rows;

  const only = (process.env.HYROS_AD_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (only.length) accounts = accounts.filter((a) => only.includes(String(a.id)));
  // Zero ad accounts is a CRM-only account, not a failure: the report is
  // empty, the CRM is full. Only the ad-accounts call itself failing throws.

  const adAccountName = new Map(accounts.map((a) => [String(a.id), a.name]));

  onProgress('sources');
  const sourcesPage = await callToolPagedInfo('hyros_get_sources',
    { request: { includeOrganic: true, includeDisregarded: false } },
    { maxPages: SOURCES_MAX_PAGES, pageSize: 250, deadline: coreDeadline });
  const sourcesRaw = sourcesPage.rows;

  const sourceById = new Map();
  for (const s of sourcesRaw) {
    const key = String(s.adSource?.adSourceId ?? '');
    if (!key) continue;
    sourceById.set(key, {
      name: s.name,
      tag: s.tag,
      category: s.category?.name || null,
      trafficSource: s.trafficSource?.name || null,
      adAccountId: s.adSource?.adAccountId ? String(s.adSource.adAccountId) : null,
      platform: s.adSource?.platform || null,
    });
  }

  const ranges = buildRanges(now, tz);
  const out = {};

  // One ad account failing (unsupported level, disconnected integration, …)
  // must not take the whole snapshot down: it is recorded in `warnings`,
  // skipped for the remaining ranges, and the other accounts still report.
  // Every warning is { adAccountId, name, type, level, error, kind } with
  // kind ∈ 'unsupported' | 'rate_limited' | 'error' | 'truncated' | 'time budget'.
  const warnings = [];
  const failed = new Set();
  const warn =(acct, level, error, kind = 'error') => {
    warnings.push({ adAccountId: acct ? String(acct.id) : null, name: acct?.name || null, type: acct?.type || null, level, error: String(error), kind });
    onProgress(`skip ${acct?.name || acct?.id || 'core'}: ${error}`);
  };
  // The account timezone decides what "today" is; a value we cannot read
  // falls back to UTC, but never quietly.
  if (!parseTimezone(tz)) warn(null, null, `timezone ${tz} not understood, using UTC`, 'error');

  // Stages: fetched once (the CRM reuses them) and used to validate the saved
  // leadStage filter — the API answers 400 for an unknown stage name, which
  // would fail every level of every range for one typo.
  onProgress('stages');
  let stagesRaw = null;
  try {
    stagesRaw = await callToolPaged('hyros_get_stages', { request: {} }, { maxPages: 1, pageSize: 250 });
  } catch (err) {
    if (err?.name === 'McpNotConfigured' || err?.code === 'auth') throw err;
    warn(null, 'stages', `stages: ${err.message}`, err?.code === 'rate_limited' ? 'rate_limited' : 'error');
  }
  const settings = stagesRaw ? validateLeadStage(saved, stagesRaw, warn) : saved;

  const reportable = accounts.filter((acct) => {
    if (LEVELS_BY_TYPE[acct.type]) return true;
    warn(acct, null, `no attribution report level for ad account type ${acct.type}`, 'unsupported');
    return false;
  });
  // Time budget. Attribution calls stop at the core's reservation; a call
  // started just before it may overrun into the CRM slot (its timeout
  // shrinks so it never reaches the features slot).
  const outOfTime = () => Date.now() >= coreDeadline;
  // One sixth of the core reservation, between the floor and the cap: 15 s on
  // the cron share, ~22 s on a manual refresh.
  const attributionTimeoutMs = Math.min(ATTRIBUTION_TIMEOUT_MAX_MS, Math.max(ATTRIBUTION_TIMEOUT_MS, Math.floor((coreDeadline - Date.now()) / 6)));
  const callTimeout = () => clampTimeout(attributionTimeoutMs, crmDeadline);

  const fetchLevelSafe = async (acct, level, range) => {
    const id = String(acct.id);
    const key = `${id}:${level}`;
    if (failed.has(key)) return [];
    try {
      const { rows, truncated, error } = await fetchLevel(level, id, range, settings, { deadline: coreDeadline, timeoutMs: callTimeout(), tz, now });
      if (truncated) warn(acct, level, `showing newest ${rows.length} rows${error ? ` (${error})` : ''}`, 'truncated');
      return rows;
    } catch (err) {
      if (err?.name === 'McpNotConfigured' || err?.code === 'auth') throw err;
      // A 429 is the account's shared budget, not this level being broken:
      // warn, and try again on the next range instead of blacklisting.
      if (err?.code === 'rate_limited') { warn(acct, level, err.message, 'rate_limited'); return []; }
      // A timeout at the deadline is our budget, not the level.
      if (err?.code === 'timeout' && outOfTime()) { warn(acct, level, err.message, 'time budget'); return []; }
      failed.add(key);
      warn(acct, level, err?.message || err, /unsupported level/i.test(err?.message || '') ? 'unsupported' : 'error');
      return [];
    }
  };

  // A range the budget did not reach: same shape, empty, marked. Rows fetched
  // for a range that was cut mid-way are discarded rather than presented as
  // that range's totals.
  const skippedRange = (range) => ({
    ...range, skipped: 'time budget',
    levels: buildLevels({ adsetRows: [], adRows: [], sourceById, adAccountName }),
    totals: aggregate([]),
  });
  const skippedKeys = [];

  for (const [key, range] of Object.entries(ranges)) {
    if (outOfTime()) { out[key] = skippedRange(range); skippedKeys.push(key); continue; }
    onProgress(`range ${key}`);
    const adsetRows = [];
    const adRows = [];
    let cut = false;
    for (const acct of reportable) {
      const { adset, ad } = LEVELS_BY_TYPE[acct.type];
      // Sequential per account: the MCP limit is per HYROS account (30/s,
      // 1000/min, shared by every key of the account and by an agency's
      // clients), so parallel fan-out here only trades rows for 429s.
      if (outOfTime()) { cut = true; break; }
      adsetRows.push(...await fetchLevelSafe(acct, adset, range));
      if (!ad) continue;
      if (outOfTime()) { cut = true; break; }
      adRows.push(...await fetchLevelSafe(acct, ad, range));
    }
    if (cut) { out[key] = skippedRange(range); skippedKeys.push(key); continue; }
    const levels = buildLevels({ adsetRows, adRows, sourceById, adAccountName });
    out[key] = {
      ...range,
      levels,
      totals: aggregate(adsetRows),
    };
  }
  if (skippedKeys.length) warn(null, null, `range${skippedKeys.length > 1 ? 's' : ''} ${skippedKeys.join(', ')} skipped: time budget`, 'time budget');

  // Nothing reported (unsupported-only account, every integration broken) is
  // still a snapshot: empty levels + warnings say why, and the CRM is real.

  onProgress('crm');
  const today = ymdInTz(now, tz);
  const prevCrm = previous?.crm;
  let crm;
  if (Array.isArray(prevCrm?.leads) && crmDeadline - Date.now() < crmMinMs(plan)) {
    // The core overran into the CRM slot and too little of it is left for a
    // pull: keep the last one, marked stale, so the tab never goes blank.
    // Its sync.syncedAt stays the real sync time, which is what the next
    // incremental pull is based on.
    crm = { ...prevCrm, sync: { ...(prevCrm.sync || {}), stale: true, skipped: 'time budget' } };
    warn(null, null, 'CRM not refreshed: time budget (showing the previous sync)', 'time budget');
  } else {
    const built = await buildCrm({ leadsFrom: addDays(today, -29), leadsTo: today, previous, now, deadline: crmDeadline, tz, stages: stagesRaw || [] });
    crm = built.block;
    for (const note of built.notes) warn(null, 'crm', `CRM ${note}`, 'truncated');
  }
  // Sources beyond the cap become "Uncategorised / Unknown" rollup rows, so say so.
  if (sourcesPage.truncated) warn(null, 'sources', `sources: showing ${sourcesRaw.length} of more${sourcesPage.error ? ` (${sourcesPage.error})` : ''}`, 'truncated');
  if (accountsPage.truncated) warn(null, 'adAccounts', `ad accounts: showing ${accounts.length} of more`, 'truncated');

  // Feature server steps (Scale Advisor, Tracking Health, anything a user
  // adds under public/features/) — best-effort inside the remaining budget.
  const core = { schema: 2, attributionModel: model, settings, adAccounts: accounts.map((a) => ({ id: String(a.id), name: a.name, type: a.type })), ranges: out, crm, warnings, account: { email: user?.userProfile?.email || null, timezone: tz } };
  const featureBlocks = await runFeatureSteps({ snapshot: core, previous, deadline, onProgress });

  return {
    schema: 2,
    templateVersion: TEMPLATE_VERSION,
    generatedAt: new Date().toISOString(),
    origin: 'mcp',
    attributionModel: model,
    settings,
    account: {
      email: user?.userProfile?.email || null,
      timezone: tz,
      currency: user?.trueTrackingData?.OUTBOUND_CURRENCY || 'USD',
      attributionWindowDefault: Number(user?.trueTrackingData?.LEAD_ATTRIBUTION_TIMEFRAME) || null,
      // Agency relationships (MCP upgrade): who manages this account, and
      // which client accounts this one can operate on.
      managedBy: acctSummary(user?.allowedAccounts),
      clients: acctSummary(user?.accessibleAccounts),
    },
    adAccounts: accounts.map((a) => ({ id: String(a.id), name: a.name, type: a.type })),
    sourceCount: sourcesRaw.length,
    sourcesTruncated: Boolean(sourcesPage.truncated),
    ranges: out,
    crm,
    warnings,
    ...featureBlocks,
    buildMs: Date.now() - started,
  };
}
