/**
 * Tracking Health — server step. Returns the block stored as snapshot.health.
 *
 * Three independent checks, run cheapest first so a slow HYROS answer can
 * never starve the others: the verified-domain list, the two Google
 * tracking-parameter checks, and LAST the script-presence check, which
 * fetches every domain live and regularly needs more than the 15 s per-call
 * contract — it gets the runner's slow lane (`ctx.timeouts.slow`) when one
 * is offered.
 *
 * Every check records what happened in `checks.<name>`:
 *   { status: 'ok' | 'empty' | 'skipped' | 'failed', reason?, ms? }
 * so the view can say "skipped: time budget" or "HYROS did not answer" in
 * the tile itself instead of a grey footnote. `errors[]` keeps the failed
 * checks as strings for older readers of the block; skips are not errors.
 *
 * Neither tool has a documented argument or reply schema (FINDINGS.md), so
 * replies are read tolerantly, and a reply the code cannot read is a failed
 * check ("unexpected reply shape") rather than a silently empty result.
 */
const DEFAULT_TIMEOUT_MS = 15000;        // FEATURES.md: the per-call contract
const SLOW_MIN_LEFT_MS = 8000;           // below this the script check is skipped, not started
const SLOW_MARGIN_MS = 2000;             // the slow call must end this long before the step deadline
const MIN_CALL_BUDGET_MS = 3000;         // do not start a cheap call with less than this left
const MAX_DOMAINS = 20;
// The live MCP refuses more: "The maximum number of domains to be provided for inspection is 3" (observed 2026-09-21; not in the docs).
const MAX_URLS_PER_CALL = 3;   // the MCP rejects more per inspection
const MAX_SITE_URLS = 12;      // 4 batches at most; time budget usually stops earlier
const MAX_PARAM_ROWS = 50;
// The script check reads the raw page, so a script a site builder injects at
// runtime reads "not found" on pages HYROS is tracking. Recent leads' clicks
// are the proof a site is tracked: up to 50 leads (the tool's limit), 7 days.
const MAX_CLICK_LEADS = 50;
const VISIT_DAYS = 7;
const MAX_CLICK_PAGES = 4;
const SCRIPT_FOUND_RE = /^(SCRIPT_FOUND|FOUND|OK|PRESENT|INSTALLED)$/i;
const GOOGLE_CHANNELS = ['SEARCH', 'PERFORMANCE_MAX'];
const MARKERS = ['skipped', 'error', 'stale'];
const COMPLETED = new Set(['ok', 'empty']);

const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The data keys of a block, without the runner's markers. */
const dataOf = (block) => (isMap(block) ? Object.fromEntries(Object.entries(block).filter(([k]) => !MARKERS.includes(k))) : {});

/** Out of time before the first call: previous data marked stale, or a bare marker. */
const skippedBlock = (previous, reason) => (Object.keys(dataOf(previous)).length
  ? { ...dataOf(previous), stale: true, skipped: reason }
  : { skipped: reason });

// --- per-check status records -------------------------------------------------
const ok = (ms) => ({ status: 'ok', ms });
const empty = (ms) => ({ status: 'empty', ms });
const skipped = (reason) => ({ status: 'skipped', reason });
const failed = (reason, ms) => (ms === undefined ? { status: 'failed', reason } : { status: 'failed', reason, ms });

// --- timeouts -----------------------------------------------------------------
/** The per-call timeout for the cheap checks: the runner's default, else the 15 s contract. */
const defaultTimeout = (ctx) => Math.min(ctx.timeouts?.default ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

/**
 * The script check's timeout. A runner that exposes `ctx.timeouts` has
 * declared a slow lane (`slow`, 45 s when unset); one that does not is still
 * on the 15 s contract, which the conformance stub enforces. Either way the
 * call ends before the step deadline.
 */
/** The runner's slow lane (ctx.slowTimeout); a runner without one keeps the default lane. */
function slowTimeout(ctx) {
  if (typeof ctx.slowTimeout === 'function') return ctx.slowTimeout(SLOW_MARGIN_MS);
  return Math.min(defaultTimeout(ctx), ctx.timeLeft() - SLOW_MARGIN_MS);
}

const isTimeout = (err) => err?.code === 'timeout' || /timed out/i.test(err?.message || '');

/** A tool call with a stopwatch: { value, ms } or { error, ms } — never throws. */
async function timed(callTool, name, args, timeoutMs) {
  const started = Date.now();
  try { return { value: await callTool(name, args, { timeoutMs }), ms: Date.now() - started }; }
  catch (error) { return { error, ms: Date.now() - started }; }
}

// --- reply readers (undocumented shapes, read tolerantly) ----------------------
/** hyros_get_domains: string[] | { result | domains: [string | { domain | name | url }] }. */
function readDomains(d) {
  const list = Array.isArray(d) ? d : (Array.isArray(d?.result) ? d.result : (Array.isArray(d?.domains) ? d.domains : []));
  return list.map((x) => (typeof x === 'string' ? x : x?.domain || x?.name || x?.url)).filter(Boolean).slice(0, MAX_DOMAINS);
}

/**
 * hyros_assert_script_presence_on_domain: { url: status } (possibly under
 * `result`), or [{ url | domain, status | result | present }]. Anything else
 * is "unexpected": returns null so the caller can record it.
 */
function readScripts(r) {
  const map = isMap(r?.result) ? r.result : r;
  if (isMap(map)) return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === 'string' ? v : (v?.status ?? v?.result ?? String(v))]));
  if (Array.isArray(map) && map.length && map.every(isMap)) {
    const entries = map.map((row) => [row.url || row.domain, row.status ?? row.result ?? (row.present === undefined ? undefined : (row.present ? 'SCRIPT_FOUND' : 'SCRIPT_NOT_FOUND'))])
      .filter(([k, v]) => k && v !== undefined);
    return entries.length ? Object.fromEntries(entries) : null;
  }
  return null;
}

/** hyros_check_tracking_parameters_for_integrations: rows under result | ads, a bare array, or one object. */
function readParamRows(r) {
  const rows = Array.isArray(r) ? r : (Array.isArray(r?.result) ? r.result : (Array.isArray(r?.ads) ? r.ads : (isMap(r) ? [r] : [])));
  return rows.slice(0, MAX_PARAM_ROWS);
}

const toUrl = (dom) => (/^https?:\/\//.test(dom) ? dom : `https://${dom}/`);

/**
 * The verified domains HYROS returns are the TRACKING domains: the CNAMEs a
 * customer points at HYROS (data.shop.com). The universal script lives on
 * the site itself (shop.com, www.shop.com), so that is what the presence
 * check must fetch. Strip the tracking label down to the registrable domain,
 * keeping a second-level public suffix such as co.uk / com.mx intact.
 */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'gob']);
export function siteOf(trackingDomain) {
  const host = String(trackingDomain || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '').toLowerCase();
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return host;
  const keep = labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** Site URLs to fetch for a list of tracking domains: every apex first, then www variants, deduplicated, capped. */
export function siteTargets(domains, max = MAX_SITE_URLS) {
  const out = [];
  const seen = new Set();
  const push = (url, trackingDomain) => { if (!seen.has(url) && out.length < max) { seen.add(url); out.push({ url, trackingDomain }); } };
  const apexes = domains.map((d) => ({ apex: siteOf(d), trackingDomain: d })).filter((x) => x.apex);
  // Apex and www of one site go in together: when the cap is hit a whole site is left out, never half of one.
  for (const x of apexes) { push(`https://${x.apex}/`, x.trackingDomain); push(`https://www.${x.apex}/`, x.trackingDomain); }
  return out;
}

// --- the three checks ---------------------------------------------------------
async function checkDomains(ctx) {
  ctx.log('health domains');
  const r = await timed(ctx.callTool, 'hyros_get_domains', {}, defaultTimeout(ctx));
  if (r.error) return { domains: [], check: failed(r.error.message, r.ms) };
  const domains = readDomains(r.value);
  return { domains, check: domains.length ? ok(r.ms) : empty(r.ms) };
}

/** One channel of the parameter check: { type, rows?, status, error? }. */
async function checkChannel(ctx, type) {
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return { type, status: 'skipped', ms: 0 };
  ctx.log(`health params ${type}`);
  const r = await timed(ctx.callTool, 'hyros_check_tracking_parameters_for_integrations', { request: { type } }, defaultTimeout(ctx));
  if (r.error) return { type, status: 'failed', error: `params ${type}: ${r.error.message}`, ms: r.ms };
  const rows = readParamRows(r.value);
  return { type, rows, status: rows.length ? 'ok' : 'empty', ms: r.ms };
}

/** The overall params status from its channels: any rows → ok; ran but nothing → empty; else failed before skipped. */
function paramsStatus(results) {
  const statuses = results.map((c) => c.status);
  if (statuses.includes('ok')) return { status: 'ok' };
  if (statuses.includes('empty')) return { status: 'empty' };
  if (statuses.includes('failed')) return { status: 'failed', reason: results.filter((c) => c.error).map((c) => c.error.replace(/^params /, '')).join(' · ') };
  return { status: 'skipped', reason: 'time budget' };
}

async function checkParams(ctx, hasGoogle) {
  if (!hasGoogle) return { trackingParams: [], errors: [], check: skipped('no Google ad accounts connected') };
  const results = [];
  for (const type of GOOGLE_CHANNELS) results.push(await checkChannel(ctx, type));   // sequential: one rate limit per account
  const channels = Object.fromEntries(results.map((c) => [c.type, c.status]));
  const ms = results.reduce((sum, c) => sum + c.ms, 0);
  return {
    trackingParams: results.filter((c) => c.rows).map(({ type, rows }) => ({ type, rows })),
    errors: results.filter((c) => c.error).map((c) => c.error),
    check: { ...paramsStatus(results), ms, channels },
  };
}

const scriptFailure = (err, timeoutMs) => (isTimeout(err)
  ? `HYROS did not answer within ${Math.round(timeoutMs / 1000)}s (the check fetches every domain live)`
  : err.message);

async function checkScript(ctx, domains, domainsCheck) {
  if (domainsCheck.status === 'failed') return { scripts: {}, check: skipped('domains check failed') };
  if (!domains.length) return { scripts: {}, check: skipped('no verified domains') };
  if (ctx.timeLeft() < SLOW_MIN_LEFT_MS) return { scripts: {}, check: skipped('time budget') };
  // The MCP inspects at most 3 URLs per call and does not follow redirects
  // (an apex that 307s to www reads as "not found"), so every site gets its
  // apex AND its www variant, sent in batches of 3 while the budget allows.
  const sites = siteTargets(domains);
  let scripts = {};
  let checked = 0;
  let ms = 0;
  let stop = null;
  for (let i = 0; i < sites.length; i += MAX_URLS_PER_CALL) {
    if (ctx.timeLeft() < SLOW_MIN_LEFT_MS) { stop = 'time budget'; break; }
    const batch = sites.slice(i, i + MAX_URLS_PER_CALL);
    const timeoutMs = slowTimeout(ctx);
    ctx.log(`health script ${i / MAX_URLS_PER_CALL + 1}/${Math.ceil(sites.length / MAX_URLS_PER_CALL)}`);
    // Every MCP tool takes its arguments under `request` (flat args answer "Missing required property: request").
    const r = await timed(ctx.callTool, 'hyros_assert_script_presence_on_domain', { request: { domains: batch.map((x) => x.url) } }, timeoutMs);
    ms += r.ms || 0;
    if (r.error) { stop = scriptFailure(r.error, timeoutMs); break; }
    const got = readScripts(r.value);
    if (!got) { stop = 'unexpected reply shape'; break; }
    scripts = { ...scripts, ...got };
    checked += batch.length;
  }
  if (!checked) return { scripts: {}, sites, check: stop && stop !== 'time budget' ? failed(stop, ms) : skipped(stop || 'time budget') };
  const base = Object.keys(scripts).length ? ok(ms) : empty(ms);
  if (checked < sites.length) {
    return { scripts, sites, check: { ...base, reason: `checked ${checked} of ${sites.length} URLs; the rest: ${stop || 'time budget'}` } };
  }
  return { scripts, sites, check: base };
}

/** Hostname without www, lowercased; null for anything that is not a URL. */
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/**
 * Only when a URL came back without the script: the hosts HYROS recorded
 * visits on in the last VISIT_DAYS days, from the newest leads' clicks. A
 * failure here is a failed visits check, never a failed step.
 */
async function checkVisits(ctx, scripts, now) {
  const misses = Object.values(scripts || {}).filter((st) => !SCRIPT_FOUND_RE.test(String(st)));
  if (!misses.length) return { visitedHosts: [], check: skipped('every checked URL has the script') };
  // A full CRM pull keeps HYROS's order, so sort by latest activity here.
  const activity = (l) => String(l?.lastSourceDate || l?.joined || '');
  const leadIds = [...(ctx.snapshot?.crm?.leads || [])].filter((l) => l?.id)
    .sort((a, b) => activity(b).localeCompare(activity(a)))
    .map((l) => String(l.id)).slice(0, MAX_CLICK_LEADS);
  if (!leadIds.length) return { visitedHosts: [], check: skipped('no recent leads to read visits from') };
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return { visitedHosts: [], check: skipped('time budget') };
  const fromDate = new Date(now.getTime() - VISIT_DAYS * 86400000).toISOString().slice(0, 10);
  ctx.log('health visits');
  const hosts = new Set();
  let pageId = null;
  let ms = 0;
  for (let page = 0; page < MAX_CLICK_PAGES; page += 1) {
    if (page && ctx.timeLeft() < MIN_CALL_BUDGET_MS) break;
    const request = { leadIds, fromDate, pageSize: 250, ...(pageId ? { pageId } : {}) };
    const r = await timed(ctx.callTool, 'hyros_get_lead_clicks', { request }, defaultTimeout(ctx));
    ms += r.ms || 0;
    if (r.error) {
      if (!page) return { visitedHosts: [], check: failed(r.error.message, ms) };
      break;
    }
    const rows = Array.isArray(r.value) ? r.value : (Array.isArray(r.value?.result) ? r.value.result : []);
    for (const c of rows) { const h = hostOf(c?.page || c?.url || c?.pageUrl); if (h) hosts.add(h); }
    pageId = r.value?.nextPageId || null;
    if (!pageId) break;
  }
  const visitedHosts = [...hosts].sort();
  return { visitedHosts, check: visitedHosts.length ? ok(ms) : empty(ms) };
}

/**
 * The script check is the expensive one, so when it could not run this
 * refresh the panel still shows the last known per-URL results: the
 * previous block's `scripts`, with the check marked `stale` and dated by the
 * refresh that produced them (kept through repeated carry-forwards). Only a
 * previous check that completed — or was itself carried forward — counts; a
 * block from before `checks` existed counts when it has results.
 */
function carryScripts(previous, check) {
  const prev = dataOf(previous);
  const scripts = isMap(prev.scripts) ? prev.scripts : {};
  const sites = Array.isArray(prev.sites) ? prev.sites : [];
  const prevCheck = prev.checks?.script;
  const usable = Object.keys(scripts).length && (!prevCheck || COMPLETED.has(prevCheck.status) || prevCheck.stale === true);
  if (!usable) return null;
  const checkedAt = prevCheck?.checkedAt || prev.checkedAt;
  return { scripts, sites, check: { ...check, stale: true, ...(checkedAt ? { checkedAt } : {}) } };
}

export async function build(ctx) {
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return skippedBlock(ctx.previous, 'time budget');
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const hasGoogle = (ctx.snapshot?.adAccounts || []).some((a) => /GOOGLE/.test(a.type || ''));

  const dom = await checkDomains(ctx);
  const params = await checkParams(ctx, hasGoogle);
  const script = await checkScript(ctx, dom.domains, dom.check);
  const carried = COMPLETED.has(script.check.status) ? null : carryScripts(ctx.previous, script.check);
  const visits = await checkVisits(ctx, carried ? carried.scripts : script.scripts, now);

  return {
    checkedAt: now.toISOString(),
    domains: dom.domains,
    sites: (carried ? carried.sites : script.sites) || [],
    scripts: carried ? carried.scripts : script.scripts,
    visitedHosts: visits.visitedHosts,
    trackingParams: params.trackingParams,
    errors: [
      ...(dom.check.status === 'failed' ? [`domains: ${dom.check.reason}`] : []),
      ...params.errors,
      ...(script.check.status === 'failed' ? [`script: ${script.check.reason}`] : []),
    ],
    checks: { domains: dom.check, params: params.check, script: carried ? carried.check : script.check, visits: visits.check },
  };
}
