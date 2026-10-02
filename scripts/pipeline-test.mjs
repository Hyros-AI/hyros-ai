/**
 * End-to-end test of the snapshot pipeline against the mock MCP:
 *   - ad rows keep parentId; ads link to ad sets by id even with duplicate names
 *   - saved settings reach the report request (model, window, leadStage, newestFirst)
 *   - a second build with a previous snapshot runs the INCREMENTAL lead sync
 *     (updatedFromDate) and merges correctly
 *   - Scale Advisor curves and Tracking Health land in the snapshot
 */
import { startMock, calls, mock } from './mock-mcp.mjs';

const PORT = 4322;
process.env.HYROS_MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
process.env.HYROS_API_KEY = 'mock';

const { buildSnapshot } = await import('../api/_snapshot.js');
const mcp = await import('../api/_mcp.js');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`);
  if (!ok) failures += 1;
};

const server = await startMock(PORT);
try {
  console.log('\nRefresh budget: one constant (REFRESH_MAX_S) drives maxDuration, vercel.json, the build and the cron');
  const budget = await import('../api/_budget.js');
  const { readFile } = await import('node:fs/promises');
  const vercelJson = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  check('REFRESH_MAX_S is 300 (Vercel Fluid compute) and the build budget keeps 10 s of headroom', budget.REFRESH_MAX_S === 300 && budget.REFRESH_BUDGET_MS === 290000, JSON.stringify([budget.REFRESH_MAX_S, budget.REFRESH_BUDGET_MS]));
  check('api/refresh.js exports maxDuration = REFRESH_MAX_S', (await import('../api/refresh.js')).maxDuration === budget.REFRESH_MAX_S);
  check('vercel.json declares maxDuration 300 + includeFiles for api/refresh.js', vercelJson.functions?.['api/refresh.js']?.maxDuration === budget.REFRESH_MAX_S && vercelJson.functions['api/refresh.js'].includeFiles === 'public/features/**', JSON.stringify(vercelJson.functions));
  check('cron: per-account share is min(remaining, 120 s); the whole run has the build budget, 20 s minimum per account', budget.cronAccountBudgetMs(290000) === 120000 && budget.cronAccountBudgetMs(45000) === 45000 && budget.CRON_MIN_ACCOUNT_MS === 20000 && budget.CRON_BUDGET_MS === budget.REFRESH_BUDGET_MS, JSON.stringify([budget.cronAccountBudgetMs(290000), budget.cronAccountBudgetMs(45000)]));
  check('buildSnapshot defaults to the full build budget', (await import('../api/_snapshot.js')).DEFAULT_BUDGET_MS === budget.REFRESH_BUDGET_MS);

  console.log('\nMCP transport: 429 + Retry-After, 403 vs 401, pagination info, expired cursor (api-docs.hyros.com)');
  const LIMIT_MSG = 'You have reached the MCP request limit, please wait before sending again.';
  mock.failNext({ tool: 'hyros_get_domains', status: 429, body: { error: LIMIT_MSG }, retryAfter: 1 });
  const t0 = Date.now();
  const domains = await mcp.callTool('hyros_get_domains', {}).catch((e) => e);
  check('429 is retried after Retry-After and then succeeds', Array.isArray(domains) && domains.length === 2 && Date.now() - t0 >= 900, `${domains?.message || ''} ${Date.now() - t0}ms`);
  mock.failNext({ tool: 'hyros_get_domains', status: 429, body: { error: LIMIT_MSG }, retryAfter: 0, times: 3 });
  const limited = await mcp.callTool('hyros_get_domains', {}).catch((e) => e);
  check('persistent 429 throws code rate_limited with the server text', limited?.code === 'rate_limited' && /request limit/.test(limited?.message || ''), `${limited?.code} ${limited?.message}`);
  check('429 retried at most twice (3 attempts)', calls.filter((c) => c.name === 'hyros_get_domains').length === 5, String(calls.filter((c) => c.name === 'hyros_get_domains').length));
  mock.failNext({ tool: 'hyros_get_domains', status: 403, body: { result: 'ERROR', message: 'Missing role GET_ATTRIBUTION' } });
  const forbidden = await mcp.callTool('hyros_get_domains', {}).catch((e) => e);
  check('403 surfaces as code forbidden with the server text, not auth', forbidden?.code === 'forbidden' && /Missing role/.test(forbidden?.message || ''), `${forbidden?.code} ${forbidden?.message}`);
  mock.failNext({ tool: 'hyros_get_domains', status: 401, body: { error: 'invalid api key' } });
  const unauth = await mcp.callTool('hyros_get_domains', {}).catch((e) => e);
  check('401 stays code auth and keeps the server text', unauth?.code === 'auth' && /invalid api key/.test(unauth?.message || ''), `${unauth?.code} ${unauth?.message}`);
  mock.failNext({ tool: 'hyros_get_domains', status: 500, body: 'gateway exploded' });
  const boom = await mcp.callTool('hyros_get_domains', {}).catch((e) => e);
  check('non-JSON error body keeps the HTTP status + text', /HTTP 500/.test(boom?.message || '') && /gateway exploded/.test(boom?.detail || boom?.message || ''), `${boom?.message}`);

  mock.pages('hyros_get_sales', 6, 250);
  const capped = await mcp.callToolPagedInfo('hyros_get_sales', { request: {} }, { maxPages: 4, pageSize: 250 });
  check('callToolPagedInfo: cap reached with more pages -> truncated', capped.rows.length === 1000 && capped.truncated === true && capped.pages === 4, JSON.stringify({ n: capped.rows.length, t: capped.truncated, p: capped.pages }));
  const whole = await mcp.callToolPagedInfo('hyros_get_sales', { request: {} }, { maxPages: 10, pageSize: 250 });
  check('callToolPagedInfo: exhausted list -> not truncated', whole.rows.length === 1500 && whole.truncated === false && whole.pages === 6, JSON.stringify({ n: whole.rows.length, t: whole.truncated, p: whole.pages }));
  check('callToolPagedInfo: rows have unique ids across pages', new Set(whole.rows.map((r) => r.id)).size === 1500);
  const legacyRows = await mcp.callToolPaged('hyros_get_sales', { request: {} }, { maxPages: 2, pageSize: 250 });
  check('callToolPaged is still a plain array (thin wrapper)', Array.isArray(legacyRows) && legacyRows.length === 500);
  // Deterministic on a slow runner: the first page takes 300 ms and the deadline
  // is 150 ms away, so page 1 is fetched and the loop stops before page 2.
  mock.latencyMs = { hyros_get_sales: 300 };
  const nearDeadline = await mcp.callToolPagedInfo('hyros_get_sales', { request: {} }, { maxPages: 10, pageSize: 250, deadline: Date.now() + 150 });
  mock.latencyMs = 0;
  check('callToolPagedInfo: stops paging at the deadline, flagged', nearDeadline.pages === 1 && nearDeadline.truncated === true && nearDeadline.error === 'time budget', JSON.stringify({ p: nearDeadline.pages, e: nearDeadline.error }));
  mock.expireCursorOn('hyros_get_sales');
  const partial = await mcp.callToolPagedInfo('hyros_get_sales', { request: {} }, { maxPages: 4, pageSize: 250 });
  check('expired cursor on page 2 -> rows so far + truncated + error, no throw', partial.rows.length === 250 && partial.truncated === true && /expired/.test(partial.error || ''), JSON.stringify({ n: partial.rows.length, e: partial.error }));
  mock.reset();
  calls.length = 0;

  console.log('\nFull build with settings');
  const prefs = { settings: { model: 'LAST_CLICK', windowDays: 14, leadStage: ['Customer'] } };
  // The mock's clock follows the build's `now`: the live report rejects a bound in the future.
  mock.now = Date.parse('2026-09-14T12:00:00Z');
  const snap = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs });

  const report = calls.find((c) => c.name === 'hyros_get_attribution_report')?.args.request;
  check('report request carries windowAttributionDaysRange=14', report?.windowAttributionDaysRange === 14);
  check('report request carries leadStage', JSON.stringify(report?.leadStage) === '["Customer"]');
  check('report request uses newestFirst', report?.newestFirst === true);
  check('snapshot records settings', snap.settings.windowDays === 14 && snap.settings.leadStage[0] === 'Customer');
  const { TEMPLATE_VERSION } = await import('../api/_version.js');
  check('snapshot carries templateVersion', snap.templateVersion === TEMPLATE_VERSION && /^\d+\.\d+\.\d+$/.test(snap.templateVersion), String(snap.templateVersion));
  check('attribution dates are ISO datetimes with the account offset (docs example 2021-04-16T20:35:00-05:00)', report?.startDate === '2026-09-14T00:00:00-05:00' && report?.endDate === '2026-09-14T07:00:00-05:00', JSON.stringify([report?.startDate, report?.endDate]));
  const yesterdayReport = calls.filter((c) => c.name === 'hyros_get_attribution_report').map((c) => c.args.request).find((r) => r.startDate.startsWith('2026-09-13'));
  check('today ends now (the report rejects a future endDate); a past day still ends at 23:59:59', report?.endDate === '2026-09-14T07:00:00-05:00' && yesterdayReport?.endDate === '2026-09-13T23:59:59-05:00', JSON.stringify([report?.endDate, yesterdayReport?.endDate]));
  const leadsFull = calls.find((c) => c.name === 'hyros_get_leads')?.args.request;
  const salesFull = calls.find((c) => c.name === 'hyros_get_sales')?.args.request;
  check('CRM fromDate/toDate carry time + offset too', leadsFull?.fromDate === '2026-08-16T00:00:00-05:00' && leadsFull?.toDate === '2026-09-14T07:00:00-05:00' && salesFull?.fromDate === '2026-08-16T00:00:00-05:00', JSON.stringify([leadsFull, salesFull]));
  check('snapshot ranges and CRM window stay YYYY-MM-DD', snap.ranges.today.start === '2026-09-14' && snap.ranges['30d'].start === '2026-08-16' && snap.crm.window.from === '2026-08-16' && snap.crm.window.to === '2026-09-14', JSON.stringify([snap.ranges.today, snap.crm.window]));

  const ads = snap.ranges['30d'].levels.ad;
  check('ad rows keep parentId', ads.every((a) => a.parentId), JSON.stringify(ads.map((a) => a.parentId)));
  const dupParents = ads.filter((a) => a.parentName === 'Powerset').map((a) => a.parentId);
  check('duplicate "Powerset" ad sets resolve to distinct parentIds', new Set(dupParents).size === 2);

  const levelsFor = (id) => calls.filter((c) => c.name === 'hyros_get_attribution_report' && String(c.args.request.ids[0]) === id).map((c) => c.args.request.level);
  const uniq = (id) => [...new Set(levelsFor(id))].sort().join(',');
  check('classic Google reported at campaign + ad (no adgroup level exists)', uniq('9002') === 'GOOGLE_AD,GOOGLE_CAMPAIGN', uniq('9002'));
  check('Snapchat reported at adset (the live MCP name) + ad', uniq('9003') === 'SNAPCHAT_AD,SNAPCHAT_ADSET', uniq('9003'));
  check('LinkedIn reported at campaign only', uniq('9004') === 'LINKEDIN_CAMPAIGN', uniq('9004'));
  check('Google V2 reported at adgroup only', uniq('9005') === 'GOOGLE_V2_ADGROUP', uniq('9005'));
  check('account type with no report level is skipped, not requested', levelsFor('9006').length === 0, uniq('9006'));
  check('broken account requested once per level, then skipped', levelsFor('9007').length === 2, String(levelsFor('9007').length));
  const warnIds = (snap.warnings || []).map((w) => w.adAccountId).sort().join(',');
  check('skipped + broken accounts land in snapshot.warnings', warnIds === '9006,9007,9007', warnIds);
  check('every other account still reaches the account level', ['9001', '9002', '9003', '9004', '9005'].every((id) => snap.ranges['30d'].levels.account.some((r) => r.id === id)), JSON.stringify(snap.ranges['30d'].levels.account.map((r) => r.id)));
  check('non-Meta ad rows keep parentId too', snap.ranges['30d'].levels.ad.some((a) => a.id === '9002-ad-1' && a.parentId === '9002-1'));

  check('CRM full sync (no previous)', snap.crm.sync.incremental === false && snap.crm.leads.length === 3);
  const attrFields = calls.find((c) => c.name === 'hyros_get_attribution_report')?.args.request.fields || [];
  check('switched-off LTV fields are not requested from the report', !attrFields.some((f) => /^LTV_/.test(f)) && attrFields.includes('TOTAL_REVENUE'), JSON.stringify(attrFields.filter((f) => /LTV|TOTAL_REVENUE/.test(f))));
  const s1 = snap.crm.sales.find((s) => s.id === 's1');
  const s2 = snap.crm.sales.find((s) => s.id === 's2');
  check('sale amount comes from the documented price (account currency), usdPrice kept as usdAmount', s1?.amount === 149 && s1?.currency === 'USD' && s1?.usdAmount === 160 && s1?.date === '2026-09-05T12:00:00-05:00', JSON.stringify(s1));
  check('documented sale shape: legacy date normalised to ISO, price.price + price.currency', s2?.date === '2026-07-02T01:10:33-03:00' && s2?.amount === 89 && s2?.currency === 'EUR', JSON.stringify(s2));
  check('income joined from the documented price object too', snap.crm.leads.find((l) => l.id === 'lead-2')?.income === 89, String(snap.crm.leads.find((l) => l.id === 'lead-2')?.income));
  check('agency relationship captured', snap.account.managedBy[0]?.email === 'agency@example.test');
  check('attribution window default captured', snap.account.attributionWindowDefault === 7);

  const curves = snap.scale.curves;
  check('scale: accounts + top ad sets analyzed', curves.length === snap.adAccounts.length + Math.min(6, snap.ranges['30d'].levels.adset.length), String(curves.length));
  check('scale: curve points normalized', curves[0].points.length === 5 && curves[0].points[0].spend === 20);
  check('scale: saturation spend parsed', snap.scale.curves.find((c) => c.level === 'SOURCE_LINK')?.saturationSpend === 70, JSON.stringify(snap.scale.curves.find((c) => c.level === 'SOURCE_LINK')?.saturationSpend));
  // An account-level curve has no ceiling unless the user set one (docs: the
  // ceiling is the caller's or none) — a fabricated $100 would invent a saturation point.
  check('scale: account call sends no cacCeiling when HYROS_CAC_CEILING is unset', calls.find((c) => c.name === 'hyros_get_marginal_cac_curve' && c.args.request.level === 'ACCOUNT')?.args.request.cacCeiling === undefined, JSON.stringify(calls.find((c) => c.name === 'hyros_get_marginal_cac_curve' && c.args.request.level === 'ACCOUNT')?.args.request));

  check('health: domains listed', snap.health.domains.length === 2);
  check('health: script presence per URL', snap.health.scripts['https://example.test/'] === 'SCRIPT_FOUND');
  check('health: Google tracking params checked', snap.health.trackingParams.length === 2 && snap.health.trackingParams[0].rows.length === 2);

  console.log('\nRate limit inside the range loop: warned, never blacklisted');
  const KINDS = ['unsupported', 'rate_limited', 'error', 'truncated', 'time budget'];
  check('every warning carries a documented kind', snap.warnings.every((w) => KINDS.includes(w.kind)), JSON.stringify(snap.warnings.map((w) => w.kind)));
  check('no-level account is kind unsupported, broken account is kind error', snap.warnings.find((w) => w.adAccountId === '9006')?.kind === 'unsupported' && snap.warnings.filter((w) => w.adAccountId === '9007').every((w) => w.kind === 'error'));
  calls.length = 0;
  mock.failNext({ tool: 'hyros_get_attribution_report', status: 429, body: { error: LIMIT_MSG }, retryAfter: 0, times: 3 });
  const snapRl = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs });
  const rlWarn = snapRl.warnings.find((w) => w.kind === 'rate_limited');
  check('rate-limited level lands in warnings with kind rate_limited + server text', rlWarn?.adAccountId === '9001' && /request limit/.test(rlWarn?.error || ''), JSON.stringify(snapRl.warnings));
  check('rate-limited account is retried on the next range, not blacklisted', levelsFor('9001').length === 10 && snapRl.ranges['30d'].levels.account.some((r) => r.id === '9001'), String(levelsFor('9001').length));
  mock.reset();

  console.log('\nAttribution rows are paginated (docs: pageSize 1-250, nextPageId)');
  mock.adAccounts = [{ id: '9001', name: 'Mock Meta', type: 'FACEBOOK' }];
  mock.pages('hyros_get_attribution_report', 3, 250);
  calls.length = 0;
  const snapPg = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs });
  check('3 pages -> 750 ad-set rows per range, nothing truncated', snapPg.ranges['30d'].levels.adset.length === 750 && !snapPg.warnings.some((w) => w.kind === 'truncated'), `${snapPg.ranges['30d'].levels.adset.length} ${JSON.stringify(snapPg.warnings)}`);
  check('pages requested with the previous nextPageId', calls.filter((c) => c.name === 'hyros_get_attribution_report' && c.args.request.pageId).length === 4 * 2 * 2, String(calls.filter((c) => c.name === 'hyros_get_attribution_report' && c.args.request.pageId).length));
  mock.pages('hyros_get_attribution_report', 10, 250);
  const snapCap = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs });
  const capWarn = snapCap.warnings.find((w) => w.kind === 'truncated' && w.level === 'FACEBOOK_ADSET');
  check('past the page cap: newest rows kept + kind truncated warning', snapCap.ranges['30d'].levels.adset.length === 2000 && /showing newest 2000 rows/.test(capWarn?.error || ''), `${snapCap.ranges['30d'].levels.adset.length} ${JSON.stringify(capWarn)}`);
  mock.reset();

  console.log('\nCore time budget: slow attribution calls never run past budgetMs');
  const { ATTRIBUTION_TIMEOUT_MS } = await import('../api/_snapshot.js');
  check('attribution call timeout is at most 15 s', ATTRIBUTION_TIMEOUT_MS <= 15000, String(ATTRIBUTION_TIMEOUT_MS));
  mock.adAccounts = [{ id: '9001', name: 'Mock Meta', type: 'FACEBOOK' }];
  mock.latencyMs = { hyros_get_attribution_report: 1500 };
  calls.length = 0;
  const tBudget = Date.now();
  const snapSlow = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, budgetMs: 9000 });
  const slowMs = Date.now() - tBudget;
  check('build returns inside the budget (+2 s grace)', slowMs < 11000, `${slowMs}ms`);
  const skippedRanges = Object.entries(snapSlow.ranges).filter(([, r]) => r.skipped === 'time budget');
  check('unfetched ranges are marked skipped: time budget with empty levels', skippedRanges.length >= 1 && skippedRanges.every(([, r]) => r.levels.adset.length === 0 && r.levels.ad.length === 0 && r.totals.cost === 0), JSON.stringify(Object.entries(snapSlow.ranges).map(([k, r]) => [k, r.skipped || 'ok'])));
  check('the first range was still fetched', snapSlow.ranges.today.skipped === undefined && snapSlow.ranges.today.levels.adset.length === 3, JSON.stringify(snapSlow.ranges.today.skipped));
  check('a kind "time budget" warning names the skipped ranges', snapSlow.warnings.some((w) => w.kind === 'time budget' && /range/.test(w.error)), JSON.stringify(snapSlow.warnings));
  check('CRM still built when there is no previous to reuse', snapSlow.crm.leads.length === 3 && snapSlow.crm.sync.stale === undefined);
  calls.length = 0;
  const snapStale = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: snap, budgetMs: 3000 });
  check('near the deadline the previous CRM is reused, marked stale, no CRM calls', snapStale.crm.sync.stale === true && snapStale.crm.leads.length === 3 && !calls.some((c) => c.name === 'hyros_get_leads'), JSON.stringify({ sync: snapStale.crm.sync, leadsCalls: calls.filter((c) => c.name === 'hyros_get_leads').length }));
  check('stale CRM is a kind "time budget" warning', snapStale.warnings.some((w) => w.kind === 'time budget' && /CRM/.test(w.error)), JSON.stringify(snapStale.warnings));
  mock.reset();

  console.log('\nProportional reservations: core <= 45 %, CRM <= 30 %, features the rest (at least 60 s when the budget allows)');
  const plan290 = budget.planBudget(290000);
  check('290 s plan: core 130.5 s, CRM 87 s, features 72.5 s — the core leaves >= 90 s for CRM + features', plan290.coreMs === 130500 && plan290.crmMs === 87000 && plan290.featuresMs === 72500 && 290000 - plan290.coreMs >= 90000, JSON.stringify(plan290));
  const plan120 = budget.planBudget(120000);
  check('120 s cron share: features keep the 60 s floor, core : CRM stay 3 : 2 in the rest', plan120.featuresMs === 60000 && plan120.coreMs === 36000 && plan120.crmMs === 24000, JSON.stringify(plan120));
  check('every plan adds up to the budget; a zero budget plans zeros', [0, 1, 999, 20000, 290000].every((b) => { const p = budget.planBudget(b); return p.coreMs + p.crmMs + p.featuresMs === b; }) && JSON.stringify(budget.planBudget(0)) === '{"budgetMs":0,"coreMs":0,"crmMs":0,"featuresMs":0}');
  check('the previous CRM is reused only when less than min(10 s, a quarter of the CRM slot) is left (an overrun of one 15 s call on the 120 s cron share still pulls)', budget.crmMinMs(plan290) === 10000 && budget.crmMinMs(plan120) === 6000 && plan120.crmMs - ATTRIBUTION_TIMEOUT_MS >= budget.crmMinMs(plan120), JSON.stringify([budget.crmMinMs(plan290), budget.crmMinMs(plan120)]));
  mock.adAccounts = [{ id: '9001', name: 'Mock Meta', type: 'FACEBOOK' }];
  mock.latencyMs = { hyros_get_attribution_report: 1500 };
  const planRes = budget.planBudget(20000);
  const resSteps = [];
  const tRes = Date.now();
  const snapRes = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: snap, budgetMs: 20000, onProgress: (s) => resSteps.push(s) });
  const resMs = Date.now() - tRes;
  check('slow attribution stops at the core reservation: a range is skipped and the build ends within core + one overrunning call', Object.values(snapRes.ranges).some((r) => r.skipped === 'time budget') && resMs < planRes.coreMs + ATTRIBUTION_TIMEOUT_MS + 3000, JSON.stringify({ resMs, plan: planRes, ranges: Object.entries(snapRes.ranges).map(([k, r]) => [k, r.skipped || 'ok']) }));
  check('…and the CRM still runs inside its own reservation (incremental, not stale)', snapRes.crm.sync.stale === undefined && snapRes.crm.sync.incremental === true && snapRes.crm.leads.length >= 3, JSON.stringify(snapRes.crm.sync));
  check('the reservations are printed in the steps log', resSteps.some((s) => /^budget 20s: core <= 6s, crm <= 4s, features >= 10s$/.test(s)), JSON.stringify(resSteps.filter((s) => /budget/.test(s))));
  mock.reset();

  console.log('\nCRM completeness: lists page to 10,000 rows, bounded by the CRM reservation');
  mock.adAccounts = [];
  mock.pages('hyros_get_calls', 8, 250);
  calls.length = 0;
  // Count only the core's requests: a fork's feature step may pull calls itself.
  let coreCallsEnd = -1;
  const snapCalls = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs,
    onProgress: (s) => { if (coreCallsEnd < 0 && /^feature /.test(s)) coreCallsEnd = calls.length; } });
  const coreCalls = coreCallsEnd < 0 ? calls : calls.slice(0, coreCallsEnd);
  check('8 pages of calls -> 2,000 calls, truncated.calls === false', snapCalls.crm.calls.length === 2000 && snapCalls.crm.sync.truncated.calls === false && snapCalls.crm.totals.calls === 2000, JSON.stringify([snapCalls.crm.calls.length, snapCalls.crm.sync.truncated]));
  check('calls paged with the previous nextPageId (8 requests)', coreCalls.filter((c) => c.name === 'hyros_get_calls').length === 8, String(coreCalls.filter((c) => c.name === 'hyros_get_calls').length));
  mock.latencyMs = { hyros_get_calls: 150 };
  const snapCut = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, budgetMs: 1200 });
  check('a small budget cuts the pull: truncated.calls === true with the rows fetched so far, a "time budget" note', snapCut.crm.sync.truncated.calls === true && snapCut.crm.calls.length > 0 && snapCut.crm.calls.length < 2000 && snapCut.warnings.some((w) => w.kind === 'truncated' && /calls: showing \d+ rows \(time budget\)/.test(w.error)), JSON.stringify([snapCut.crm.calls.length, snapCut.crm.sync.truncated, snapCut.warnings.filter((w) => /calls/.test(w.error))]));
  check('lists the deadline did not cut stay untruncated', snapCut.crm.sync.truncated.leads === false && snapCut.crm.sync.truncated.sales === false && snapCut.crm.sync.truncated.subscriptions === false, JSON.stringify(snapCut.crm.sync.truncated));
  mock.reset();

  console.log('\nCRM truncation is flagged, never silent');
  check('untruncated CRM carries explicit false flags', JSON.stringify(snap.crm.sync.truncated) === '{"leads":false,"sales":false,"calls":false,"subscriptions":false}' && snap.sourcesTruncated === false, JSON.stringify([snap.crm.sync.truncated, snap.sourcesTruncated]));
  mock.pages('hyros_get_leads', 41, 250);
  mock.pages('hyros_get_sources', 41, 250);
  mock.expireCursorOn('hyros_get_sales');
  mock.pages('hyros_get_sales', 3, 250);
  const snapTr = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs });
  check('leads capped at 10,000 (40 pages) and flagged only because the API had more', snapTr.crm.leads.length === 10000 && snapTr.crm.sync.truncated.leads === true, JSON.stringify([snapTr.crm.leads.length, snapTr.crm.sync.truncated]));
  check('expired sales cursor: first page kept, flagged, refresh survives', snapTr.crm.sales.length === 250 && snapTr.crm.sync.truncated.sales === true, JSON.stringify([snapTr.crm.sales.length, snapTr.crm.sync.truncated]));
  check('sources truncated at the 40-page cap: sourcesTruncated + kind truncated warning', snapTr.sourcesTruncated === true && snapTr.sourceCount === 10000 && snapTr.warnings.some((w) => w.kind === 'truncated' && /sources/.test(w.error)), JSON.stringify([snapTr.sourcesTruncated, snapTr.sourceCount, snapTr.warnings.filter((w) => w.kind === 'truncated')]));
  check('truncated CRM lists are kind truncated warnings too', snapTr.warnings.some((w) => w.kind === 'truncated' && /leads/.test(w.error)) && snapTr.warnings.some((w) => w.kind === 'truncated' && /sales/.test(w.error) && /expired/.test(w.error)), JSON.stringify(snapTr.warnings.filter((w) => w.kind === 'truncated')));
  mock.reset();

  console.log('\nCRM-only and unsupported-only accounts still build');
  process.env.HYROS_AD_ACCOUNTS = '9006';
  const onlyReddit = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs }).catch((e) => e);
  check('unsupported-only account (REDDIT) builds instead of throwing', !(onlyReddit instanceof Error), onlyReddit?.message);
  check('…with empty (not skipped) ranges, one unsupported warning and the full CRM', !(onlyReddit instanceof Error) && Object.values(onlyReddit.ranges).every((r) => r.levels.adset.length === 0 && r.skipped === undefined) && onlyReddit.warnings.filter((w) => w.kind === 'unsupported').length === 1 && onlyReddit.crm.leads.length === 3, JSON.stringify(onlyReddit?.warnings));
  delete process.env.HYROS_AD_ACCOUNTS;
  mock.adAccounts = [];
  const crmOnly = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs }).catch((e) => e);
  check('zero ad accounts (CRM-only account) builds', !(crmOnly instanceof Error) && crmOnly.adAccounts.length === 0 && crmOnly.ranges['30d'].levels.account.length === 0 && crmOnly.crm.leads.length === 3, crmOnly?.message);
  mock.failNext({ tool: 'hyros_get_ad_accounts', status: 500, body: 'upstream exploded' });
  const noList = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs }).catch((e) => e);
  check('a failed ad-accounts call itself still fails the refresh', noList instanceof Error && /HTTP 500/.test(noList.message), noList?.message);
  mock.reset();

  console.log('\nAccount timezone: IANA names work, nonsense is warned about, never silent UTC');
  mock.timezone = 'America/New_York';
  calls.length = 0;
  mock.now = Date.parse('2026-09-14T02:30:00Z');
  const snapNy = await buildSnapshot({ now: new Date('2026-09-14T02:30:00Z'), prefs });
  check('IANA timezone builds the ranges on the local day (22:30 the day before in New York)', snapNy.ranges.today.start === '2026-09-13' && snapNy.account.timezone === 'America/New_York' && !snapNy.warnings.some((w) => /timezone/.test(w.error)), JSON.stringify([snapNy.ranges.today.start, snapNy.warnings]));
  const nyReport = calls.find((c) => c.name === 'hyros_get_attribution_report')?.args.request;
  check('IANA timezone: date params carry the local time and no offset (the API assumes the account zone)', nyReport?.startDate === '2026-09-13T00:00:00' && nyReport?.endDate === '2026-09-13T22:30:00', JSON.stringify([nyReport?.startDate, nyReport?.endDate]));
  mock.timezone = 'Mars/Olympus';
  const snapMars = await buildSnapshot({ now: new Date('2026-09-14T02:30:00Z'), prefs });
  mock.now = Date.parse('2026-09-14T12:00:00Z');
  check('unknown timezone: UTC ranges + a kind error warning naming it', snapMars.ranges.today.start === '2026-09-14' && snapMars.warnings.some((w) => w.kind === 'error' && /timezone Mars\/Olympus not understood, using UTC/.test(w.error)), JSON.stringify(snapMars.warnings));
  mock.reset();

  console.log('\nleadStage is validated against the account stages (docs: unknown name -> 400 on every level)');
  calls.length = 0;
  const typoPrefs = { settings: { model: 'LAST_CLICK', windowDays: 0, leadStage: ['Custmer', 'customer', 'Lead'] } };
  let stageCoreEnd = -1;
  const snapStage = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs: typoPrefs,
    onProgress: (s) => { if (stageCoreEnd < 0 && /^feature /.test(s)) stageCoreEnd = calls.length; } });
  const stageCalls = (stageCoreEnd < 0 ? calls : calls.slice(0, stageCoreEnd)).filter((c) => c.name === 'hyros_get_stages');
  check('stages fetched once per build, not again inside the CRM', stageCalls.length === 1, String(stageCalls.length));
  const stageReq = calls.find((c) => c.name === 'hyros_get_attribution_report')?.args.request;
  check('typo dropped, case-insensitive match kept with the account spelling', JSON.stringify(stageReq?.leadStage) === '["Customer","Lead"]' && JSON.stringify(snapStage.settings.leadStage) === '["Customer","Lead"]', JSON.stringify([stageReq?.leadStage, snapStage.settings.leadStage]));
  check('the dropped stage is a kind error warning naming it', snapStage.warnings.some((w) => w.kind === 'error' && /Custmer/.test(w.error) && /stage/i.test(w.error)), JSON.stringify(snapStage.warnings.filter((w) => w.kind === 'error')));
  check('report still built for every level (no 400 storm)', snapStage.ranges['30d'].levels.adset.length === 3 + 4 && snapStage.crm.stages.length === 2, String(snapStage.ranges['30d'].levels.adset.length));
  calls.length = 0;
  mock.failNext({ tool: 'hyros_get_stages', status: 500, body: 'stages down' });
  const snapNoStages = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs: typoPrefs }).catch((e) => e);
  check('a failed stages call: build survives, saved leadStage kept as-is, warned', !(snapNoStages instanceof Error) && JSON.stringify(snapNoStages.settings.leadStage) === '["Custmer","customer","Lead"]' && snapNoStages.crm.stages.length === 0 && snapNoStages.warnings.some((w) => w.kind === 'error' && /stages/.test(w.error)), snapNoStages?.message || JSON.stringify(snapNoStages?.warnings));
  mock.reset();

  console.log('\nIncremental build (previous snapshot present)');
  calls.length = 0;
  const snap2 = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: snap });
  const leadsReq = calls.find((c) => c.name === 'hyros_get_leads')?.args.request;
  check('leads pulled with updatedFromDate', Boolean(leadsReq?.updatedFromDate) && !leadsReq?.fromDate, JSON.stringify(leadsReq));
  check('sync flagged incremental', snap2.crm.sync.incremental === true && snap2.crm.sync.leadsFetched === 3);
  check('merged: previous leads kept', snap2.crm.leads.some((l) => l.id === 'lead-3'));
  check('merged: changed lead updated in place', snap2.crm.leads.find((l) => l.id === 'lead-1')?.stage === 'Customer');
  check('merged: new lead added', snap2.crm.leads.some((l) => l.id === 'lead-9'));
  check('merged: a lead HYROS merged into another (originLead) is dropped', !snap2.crm.leads.some((l) => l.id === 'lead-2') && !('mergedInto' in snap2.crm.leads[0]), JSON.stringify(snap2.crm.leads.map((l) => l.id)));
  check('merged: income re-joined from fresh sales', snap2.crm.leads.find((l) => l.id === 'lead-1')?.income === 149);
  check('merged: no duplicates', new Set(snap2.crm.leads.map((l) => l.id)).size === snap2.crm.leads.length);
  const salesReq = calls.find((c) => c.name === 'hyros_get_sales')?.args.request;
  const callsReq = calls.find((c) => c.name === 'hyros_get_calls')?.args.request;
  check('sales and calls pulled with updatedFromDate', Boolean(salesReq?.updatedFromDate) && !salesReq?.fromDate && Boolean(callsReq?.updatedFromDate) && !callsReq?.fromDate, JSON.stringify([salesReq, callsReq]));
  check('subscriptions are still a full pull', Boolean(calls.find((c) => c.name === 'hyros_get_subscriptions')?.args.request.fromDate));
  check('merged sales: a changed sale is updated in place (now refunded)', snap2.crm.sales.find((s) => s.id === 's1')?.refunded === true, JSON.stringify(snap2.crm.sales.find((s) => s.id === 's1')));
  check('merged sales: the new sale is added, no duplicates', snap2.crm.sales.some((s) => s.id === 's3') && new Set(snap2.crm.sales.map((s) => s.id)).size === snap2.crm.sales.length, JSON.stringify(snap2.crm.sales.map((s) => s.id)));
  check('merged sales: a sale made before the window drops off', !snap2.crm.sales.some((s) => s.id === 's2'), JSON.stringify(snap2.crm.sales.map((s) => [s.id, s.date])));
  check('merged calls: the new call is added', snap2.crm.calls.some((c) => c.id === 'call-9') && snap2.crm.totals.calls === snap2.crm.calls.length, JSON.stringify(snap2.crm.calls.map((c) => c.id)));
  check('income is joined from the merged sales (the new sale counts)', snap2.crm.leads.find((l) => l.id === 'lead-9')?.income === 50, JSON.stringify(snap2.crm.leads.find((l) => l.id === 'lead-9')));
  check('sync counts what each list fetched', snap2.crm.sync.salesFetched === 2 && snap2.crm.sync.callsFetched === 1, JSON.stringify(snap2.crm.sync));
  const truncBase = { ...snap, crm: { ...snap.crm, sync: { ...snap.crm.sync, truncated: { ...snap.crm.sync.truncated, sales: true } } } };
  const snapTB = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: truncBase });
  check('a merge on top of truncated sales stays truncated', snapTB.crm.sync.truncated.sales === true && snapTB.crm.sync.truncated.calls === false, JSON.stringify(snapTB.crm.sync.truncated));

  console.log('\nA CRM trimmed for size is rebuilt with a full pull');
  calls.length = 0;
  const trimmedPrev = { ...snap, crm: { ...snap.crm, leads: snap.crm.leads.slice(0, 1), sync: { ...snap.crm.sync, sizeTrimmed: true, truncated: { ...snap.crm.sync.truncated, leads: true } } } };
  const rebuilt = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: trimmedPrev });
  check('previous trimmed (sizeTrimmed): leads, sales and calls are full pulls', rebuilt.crm.sync.incremental === false && Boolean(calls.find((c) => c.name === 'hyros_get_leads')?.args.request.fromDate) && Boolean(calls.find((c) => c.name === 'hyros_get_sales')?.args.request.fromDate), JSON.stringify(rebuilt.crm.sync));
  check('…every lead is back and the list is no longer truncated', rebuilt.crm.leads.length === 3 && rebuilt.crm.sync.truncated.leads === false, JSON.stringify([rebuilt.crm.leads.length, rebuilt.crm.sync.truncated]));
  calls.length = 0;
  const legacyTrimmed = { ...snap, warnings: [{ level: 'crm', kind: 'truncated', error: "snapshot over 9 MB (the store's request limit): kept the newest 758 leads" }] };
  const rebuiltLegacy = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: legacyTrimmed });
  check('a 0.2.3–0.2.5 snapshot trimmed for size (warning only) also gets a full pull', rebuiltLegacy.crm.sync.incremental === false, JSON.stringify(rebuiltLegacy.crm.sync));

  console.log('\nDaily cron: day 2 builds incrementally on top of day 1 (window moves, still overlaps)');
  calls.length = 0;
  mock.now = Date.parse('2026-09-15T12:00:00Z');
  const day2 = await buildSnapshot({ now: new Date('2026-09-15T12:00:00Z'), prefs, previous: { ...snap, generatedAt: '2026-09-14T12:00:00.000Z' } });
  const day2Req = calls.find((c) => c.name === 'hyros_get_leads')?.args.request;
  check('day 2 takes the incremental path', day2.crm.sync.incremental === true && String(day2Req?.updatedFromDate || '').startsWith('2026-09-13') && !day2Req?.fromDate, JSON.stringify(day2Req));
  check('window moved a day and leads outside it dropped', day2.crm.window.from === '2026-08-17' && day2.crm.leads.every((l) => String(l.joined).slice(0, 10) >= day2.crm.window.from), JSON.stringify(day2.crm.window));
  check('day 2 keeps day-1 leads and adds the new one', day2.crm.leads.some((l) => l.id === 'lead-3') && day2.crm.leads.some((l) => l.id === 'lead-9'));
  calls.length = 0;
  mock.now = Date.parse('2026-09-25T12:00:00Z');
  const old = await buildSnapshot({ now: new Date('2026-09-25T12:00:00Z'), prefs, previous: { ...snap, generatedAt: '2026-09-14T12:00:00.000Z' } });
  check('a previous older than 7 days forces a full pull', old.crm.sync.incremental === false && Boolean(calls.find((c) => c.name === 'hyros_get_leads')?.args.request.fromDate));
  calls.length = 0;
  mock.now = Date.parse('2026-09-16T12:00:00Z');
  const staleBase = await buildSnapshot({ now: new Date('2026-09-16T12:00:00Z'), prefs, previous: { ...snap, generatedAt: '2026-09-15T12:00:00.000Z', crm: { ...snap.crm, sync: { ...snap.crm.sync, stale: true } } } });
  check('a stale (reused) CRM pulls from its real syncedAt, not the reuse time', String(calls.find((c) => c.name === 'hyros_get_leads')?.args.request.updatedFromDate || '').startsWith('2026-09-13') && staleBase.crm.sync.stale === undefined, JSON.stringify(calls.find((c) => c.name === 'hyros_get_leads')?.args.request));

  console.log('\nFeature steps: fair share with a 60 s floor, the last step gets the rest, ctx.timeouts + clamped calls');
  check('stepShareMs: 2 steps in 72.5 s -> 60 s floor; last step -> all 72.5 s; fair share wins when larger; floor never exceeds what is left', budget.stepShareMs(72500, 2) === 60000 && budget.stepShareMs(72500, 1) === 72500 && budget.stepShareMs(300000, 3) === 100000 && budget.stepShareMs(30000, 3) === 30000, JSON.stringify([budget.stepShareMs(72500, 2), budget.stepShareMs(72500, 1), budget.stepShareMs(300000, 3), budget.stepShareMs(30000, 3)]));
  check('ctx.timeouts hints: default 15 s, slow 45 s (frozen)', budget.TIMEOUTS.default === 15000 && budget.TIMEOUTS.slow === 45000 && Object.isFrozen(budget.TIMEOUTS));
  const featSteps = [];
  // The mock's core + CRM take milliseconds, so the feature steps inherit
  // nearly the whole budget: 100 s -> a 50 s fair share, raised to the floor.
  const snapFeat = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, budgetMs: 100000, onProgress: (s) => featSteps.push(s) });
  const shareOf = (id) => Number((featSteps.find((s) => s.startsWith(`feature ${id} (`)) || '').match(/\((\d+)s\)/)?.[1]);
  check('scale gets the 60 s floor (not its 50 s fair share); health (last) gets everything left (~100 s)', shareOf('scale') === 60 && shareOf('health') >= 95 && snapFeat.health.scripts['https://example.test/'] === 'SCRIPT_FOUND', JSON.stringify(featSteps.filter((s) => /^feature/.test(s))));
  const fullSteps = [];
  await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, onProgress: (s) => fullSteps.push(s) });
  check('unspent core + CRM time flows to the features: on the full budget both steps get well over the floor', fullSteps.some((s) => /^feature scale \((\d+)s\)$/.test(s) && Number(s.match(/\((\d+)s\)/)[1]) >= 100), JSON.stringify(fullSteps.filter((s) => /^feature/.test(s))));
  const { featureCtx } = await import('../api/_features.js');
  const fctx = featureCtx({ id: 'health', manifest: { id: 'health' }, snapshot: snap, previous: null, deadline: Date.now() + 800 });
  check('featureCtx exposes timeouts, timeLeft and the tool calls', fctx.timeouts.slow === 45000 && fctx.timeLeft() > 0 && fctx.timeLeft() <= 800 && typeof fctx.callTool === 'function' && typeof fctx.callToolPagedInfo === 'function', JSON.stringify(Object.keys(fctx)));
  mock.latencyMs = { hyros_get_domains: 2500 };
  const tClamp = Date.now();
  const clamped = await fctx.callTool('hyros_get_domains', {}, { timeoutMs: fctx.timeouts.slow }).catch((e) => e);
  const clampMs = Date.now() - tClamp;
  check('a slow timeout is clamped to what is left of the step (never past its deadline, at least 1 s)', clamped?.code === 'timeout' && clampMs >= 900 && clampMs < 2000, JSON.stringify({ code: clamped?.code, clampMs }));
  mock.reset();
  mock.now = null; // the sections below build with the real clock
  const pctx = featureCtx({ id: 'health', manifest: { id: 'health' }, snapshot: snap, previous: null, deadline: Date.now() + 1 });
  mock.pages('hyros_get_sales', 6, 250);
  const pagedPast = await pctx.callToolPagedInfo('hyros_get_sales', { request: {} }, { maxPages: 6 });
  check('ctx.callToolPagedInfo defaults its deadline to the step deadline', pagedPast.truncated === true && pagedPast.error === 'time budget', JSON.stringify(pagedPast));
  mock.reset();

  console.log('\nFeature steps: stale reuse when the budget is spent');
  const snap3 = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: snap, budgetMs: 0 });
  check('skipped step keeps the previous block, marked stale', snap3.health.stale === true && snap3.health.skipped === 'time budget' && snap3.health.domains.length === 2, JSON.stringify(Object.keys(snap3.health)));
  check('skipped step with no previous data stays a bare marker', JSON.stringify((await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, budgetMs: 0 })).health) === '{"skipped":"time budget"}');
  check('stale block is not reused as "fresh" by the next full build', (await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: snap3 })).health.stale === undefined);

  console.log('\nMulti-account: per-key MCP context + encrypted registry');
  process.env.ACCOUNT_KEY_SECRET = 'test-secret';
  const acc = await import('../api/_accounts.js');
  const { runWithKey } = await import('../api/_mcp.js');
  const blob = acc.encryptKey('hyros-key-ABC');
  check('key encrypts to iv.tag.cipher and round-trips', blob.split('.').length === 3 && acc.decryptKey(blob) === 'hyros-key-ABC');
  check('encrypted blob never contains the key', !blob.includes('hyros-key-ABC'));
  check('account id is a stable hash of the key', acc.accountIdFor('hyros-key-ABC') === acc.accountIdFor('hyros-key-ABC') && /^acc_[0-9a-f]{12}$/.test(acc.accountIdFor('hyros-key-ABC')));
  calls.length = 0;
  const info = await acc.probeKey('client-key-XYZ');
  check('probeKey sends the CLIENT key, not the env key', calls[0]?.apiKey === 'client-key-XYZ', calls[0]?.apiKey);
  check('probeKey returns the account label', info.email === 'mock@hyros.test');
  calls.length = 0;
  await runWithKey('k-1', async () => { await import('../api/_mcp.js').then((m) => m.callTool('hyros_get_domains', {})); });
  await import('../api/_mcp.js').then((m) => m.callTool('hyros_get_domains', {}));
  check('runWithKey scopes the key; outside it the env key is used', calls[0]?.apiKey === 'k-1' && calls[1]?.apiKey === 'mock', JSON.stringify(calls.map((c) => c.apiKey)));

  console.log('\nAgency: discover clients, detect accessible_account_id mode, batch import, key health');
  // In-memory KV stand-in so the registry works without Upstash.
  const mem = new Map();
  globalThis.fetch = ((orig) => async (url, opts) => {
    if (String(url).startsWith('http://kv.local')) {
      const [cmd, k, v, ...rest] = JSON.parse(opts.body);
      if (cmd === 'GET') return new Response(JSON.stringify({ result: mem.get(k) ?? null }));
      if (cmd === 'SET') {
        if (rest.includes('NX') && mem.has(k)) return new Response(JSON.stringify({ result: null }));
        mem.set(k, v); return new Response(JSON.stringify({ result: 'OK' }));
      }
      if (cmd === 'DEL') { let n = 0; for (const key of [k, v, ...rest].filter(Boolean)) n += mem.delete(key) ? 1 : 0; return new Response(JSON.stringify({ result: n })); }
      if (cmd === 'SCAN') { const prefix = String(rest[0] || '').replace(/\*$/, ''); return new Response(JSON.stringify({ result: ['0', [...mem.keys()].filter((key) => key.startsWith(prefix))] })); }
    }
    return orig(url, opts);
  })(globalThis.fetch);
  process.env.KV_REST_API_URL = 'http://kv.local'; process.env.KV_REST_API_TOKEN = 't';
  process.env.REPORT_PASSWORD = 'pw';
  const store = await import('../api/_store.js');
  check('accounts enabled with KV + secret', acc.accountsEnabled() === true);

  const added = await acc.addAccount('agency-key', { agency: true });
  check('agency key added and clients discovered', added.account.agency === true && added.clientsFound === 7 && added.clientsApproved === 6, JSON.stringify(added));
  calls.length = 0;
  const b1 = await acc.importClients(added.account.id, { offset: 0 });
  check('first batch imports 5 of 6 approved clients', b1.added === 5 && b1.total === 6 && b1.remaining === 1 && b1.pending === 1, JSON.stringify(b1));
  check('client mode detected as ARG (verified against the client profile)', b1.clientMode === 'arg' && b1.clientModeStatus === 'verified', JSON.stringify(b1));
  const b2 = await acc.importClients(added.account.id, { offset: b1.offset });
  check('second batch imports the last client', b2.added === 1 && b2.remaining === 0);
  const list = await acc.listAccounts();
  const clients = list.filter((a) => a.kind === 'client');
  check('registry lists 6 clients under the agency', clients.length === 6 && clients.every((c) => c.parentId === added.account.id));

  calls.length = 0;
  const cli = clients[0];
  await acc.asAccount(cli.id, () => import('../api/_mcp.js').then((m) => m.callTool('hyros_get_ad_accounts', { request: {} })));
  check('client call uses the AGENCY key + accessible_account_id argument', calls[0]?.apiKey === 'agency-key' && calls[0]?.client && calls[0]?.headerClient === null, JSON.stringify(calls[0]));

  const sync = await acc.syncClients(added.account.id);
  check('client sync is idempotent', sync.added === 0 && sync.total === 7);

  // A client 403 (missing role / not authorized) is a refresh failure, NOT an invalid agency key.
  const fakeRes = () => { const r = { status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader() {} }; return r; };
  process.env.CRON_SECRET = 'cron-s';
  const refresh = (await import('../api/refresh.js')).default;
  // Structured event log (api/_log.js writes one JSON line per event to stderr).
  const logLines = [];
  const origConsoleError = console.error;
  console.error = (line) => { logLines.push(String(line)); };
  const events = (evt) => logLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.evt === evt);
  mock.failNext({ status: 403, body: { result: 'ERROR', message: 'Not authorized: account c1 is not one of your connected client accounts.' } });
  let rr = fakeRes();
  await refresh({ url: `/api/refresh?account=${cli.id}`, headers: { host: 'x', authorization: 'Bearer cron-s' } }, rr);
  check('refresh answers 502 forbidden on a client 403', rr.code === 502 && rr.body?.error === 'forbidden', JSON.stringify(rr.body));
  check('a failed refresh still reports budgetMs + elapsedMs + steps', rr.body?.budgetMs === budget.REFRESH_BUDGET_MS && typeof rr.body?.elapsedMs === 'number' && Array.isArray(rr.body?.steps), JSON.stringify([rr.body?.budgetMs, rr.body?.elapsedMs]));
  check('refresh.failed logged with accountId, code, message, ms (no key material)', events('refresh.failed').some((e) => e.accountId === cli.id && e.code === 'forbidden' && /Not authorized/.test(e.message) && typeof e.ms === 'number') && !logLines.some((l) => /agency-key/.test(l)), JSON.stringify(events('refresh.failed')));
  const after403 = await acc.listAccounts();
  check('agency key NOT marked invalid by a client 403; lastError recorded', after403.find((a) => a.id === added.account.id).keyStatus === 'ok' && /Not authorized/.test(after403.find((a) => a.id === cli.id).lastError || ''), JSON.stringify(after403.map((a) => [a.id, a.keyStatus, a.lastError])));
  rr = fakeRes();
  await refresh({ url: `/api/refresh?account=${cli.id}`, headers: { host: 'x', authorization: 'Bearer cron-s' } }, rr);
  check('a good refresh reports the snapshot size breakdown', rr.body?.size?.total > 0 && Array.isArray(rr.body.size.parts) && rr.body.size.parts.length > 0 && typeof rr.body.size.nullBytes === 'number', JSON.stringify(rr.body?.size));
  check('…including the compressed bytes actually stored', rr.body?.size?.storedBytes > 0 && rr.body.size.storedBytes < rr.body.size.total, JSON.stringify(rr.body?.size && { total: rr.body.size.total, storedBytes: rr.body.size.storedBytes }));
  check('a good refresh reports storeConfigured + persisted and logs refresh.ok with the warning count', rr.code === 200 && rr.body?.ok === true && rr.body.storeConfigured === true && rr.body.persisted === true && events('refresh.ok').some((e) => e.accountId === cli.id && typeof e.ms === 'number' && e.warnings === 3), JSON.stringify([rr.body?.storeConfigured, rr.body?.persisted, events('refresh.ok')]));
  const c = rr.body?.counts || {};
  check('a good refresh reports budgetMs, elapsedMs (= ms) and counts { leads, sales, calls, subscriptions, warnings }', rr.body?.budgetMs === budget.REFRESH_BUDGET_MS && typeof rr.body?.elapsedMs === 'number' && rr.body.elapsedMs === rr.body.ms && c.leads === 3 && c.sales === 2 && c.calls === 0 && c.subscriptions === 0 && c.warnings === 3, JSON.stringify([rr.body?.budgetMs, rr.body?.elapsedMs, c]));
  check('the response shape otherwise holds (persisted, storeConfigured, templateVersion, generatedAt, settings, steps)', typeof rr.body?.templateVersion === 'string' && typeof rr.body?.generatedAt === 'string' && rr.body?.settings?.model === 'LAST_CLICK' && rr.body.steps.some((s) => /: budget 290s: core <= 130s, crm <= 87s, features >= 72s$/.test(s)) && c.adAccounts === 7 && typeof c.sources === 'number' && c.incremental === false, JSON.stringify([Object.keys(rr.body || {}), rr.body?.steps?.[0]]));
  // Cron loop: clients of an agency whose accessible_account_id mode is unsupported are skipped, not retried daily.
  const reg = await store.readAccounts();
  reg.find((a) => a.id === added.account.id).clientModeStatus = 'unsupported';
  await store.writeAccounts(reg);
  calls.length = 0;
  rr = fakeRes();
  await refresh({ url: '/api/refresh', headers: { host: 'x', authorization: 'Bearer cron-s' } }, rr);
  const cronClients = (rr.body?.accounts || []).filter((a) => a.id.startsWith('cli_'));
  check('cron skips unsupported-mode clients with a reason and makes no MCP call for them', rr.body?.cron === true && cronClients.length === 6 && cronClients.every((a) => a.skipped === 'unsupported') && !calls.some((c) => c.client), JSON.stringify(rr.body?.accounts));
  check('cron still refreshed the agency itself', (rr.body?.accounts || []).some((a) => a.id === added.account.id && a.ok === true), JSON.stringify(rr.body?.accounts));
  const reg2 = await store.readAccounts();
  reg2.find((a) => a.id === added.account.id).clientModeStatus = 'verified';
  await store.writeAccounts(reg2);
  mock.failNext({ status: 401, body: { error: 'invalid api key' } });
  const probeFail = await acc.probeKey('whatever-key').catch((e) => e);
  check('probe.failed logged for a rejected key', probeFail?.code === 'auth' && events('probe.failed').some((e) => e.code === 'auth' && typeof e.ms === 'number'), JSON.stringify(events('probe.failed')));
  console.error = origConsoleError;
  mock.failNext({ status: 401, body: { error: 'invalid api key' } });
  rr = fakeRes();
  await refresh({ url: `/api/refresh?account=${cli.id}`, headers: { host: 'x', authorization: 'Bearer cron-s' } }, rr);
  check('a 401 on refresh DOES mark the agency key invalid', rr.body?.error === 'auth' && (await acc.listAccounts()).find((a) => a.id === added.account.id).keyStatus === 'invalid', JSON.stringify(rr.body));
  await acc.markKeyStatus(cli.id, 'ok');
  delete process.env.CRON_SECRET;

  // Key goes bad: mark invalid, clients inherit, resolve refuses with a clear code.
  await acc.markKeyStatus(cli.id, 'invalid', 'MCP rejected the API key (HTTP 401)');
  const after = await acc.listAccounts();
  check('agency + clients show key invalid', after.find((a) => a.id === added.account.id).keyStatus === 'invalid' && after.find((a) => a.id === cli.id).keyStatus === 'invalid');
  let refused = null;
  try { await acc.resolveAccount(cli.id); } catch (err) { refused = err; }
  check('client resolve refused with key_invalid', refused?.code === 'key_invalid');
  const dead = await acc.addAccount('dead-key').catch((e) => e);
  check('a rejected key cannot be added (auth error surfaced)', dead?.code === 'auth' || /rejected/.test(dead?.message || ''), dead?.message);
  const rep = await acc.replaceKey(added.account.id, 'agency-key');
  check('replace key restores the agency', rep.keyStatus === 'ok');
  check('removing the agency removes its clients', await acc.removeAccount(added.account.id) && (await acc.listAccounts()).filter((a) => a.kind === 'client').length === 0);

  console.log('\nSelf-serve setup: first run wipes + sets the KV password, generated secrets, hardening, factory reset');
  delete process.env.ACCOUNT_KEY_SECRET;
  delete process.env.CRON_SECRET;
  const setup = await import('../api/_setup.js');
  const auth = await import('../api/_auth.js');
  const reqWith = (key, headers = {}) => ({ url: `/api/data${key ? `?key=${encodeURIComponent(key)}` : ''}`, headers: { host: 'x', ...headers } });
  // Leftovers from an earlier install (the registry above was emptied, but plant a stale snapshot):
  mem.set('aihyros:snapshot:latest', JSON.stringify({ generatedAt: '2026-01-01T00:00:00Z', stale: true }));
  let st = await setup.setupState();
  check('storage present but no KV password → needs_setup (env vars do not count)', st.state === 'needs_setup' && st.storage === true && st.passwordSource === null, st.state);
  check('the env REPORT_PASSWORD is reported only as a master password', st.masterPassword === true);
  check('no KV password → data routes refuse with the setup flag (even with the env password)', (await auth.checkAccess(reqWith('pw'))).setup === true);
  check('no env HYROS_API_KEY account: nothing is listed', (await acc.listAccounts()).length === 0);
  check('accounts disabled until a secret exists', acc.accountsEnabled() === false);
  const weak = await setup.setPassword('short').catch((e) => e);
  check('short password refused', weak?.code === 'weak');
  st = await setup.setPassword('correct-horse-battery');
  check('first run → ready, secrets generated in KV', st.state === 'ready' && st.keySecret === 'kv' && st.cronSecret === 'kv' && st.pendingSecrets === true, JSON.stringify(st));
  check('first run wiped the earlier install\u2019s data', !mem.has('aihyros:snapshot:latest'));
  const dup = await setup.setPassword('another-one-1234').catch((e) => e);
  check('second first-run refused (first-come lock)', dup?.code === 'exists');
  check('checkAccess verifies the KV password (scrypt)', (await auth.checkAccess(reqWith('correct-horse-battery'))).ok === true && (await auth.checkAccess(reqWith('wrong-password-1'))).ok === false);
  check('the env REPORT_PASSWORD still works as a master password', (await auth.checkAccess(reqWith('pw'))).ok === true && (await auth.checkAccess(reqWith('pw'))).source === 'env');
  check('checkAccess accepts the Bearer form too', (await auth.checkAccess(reqWith(null, { authorization: 'Bearer correct-horse-battery' }))).ok === true);
  check('default account is null with nothing connected', (await acc.defaultAccountId()) === null);
  check('accounts enabled under the generated secret', acc.accountsEnabled() === true);
  const first = await acc.addAccount('client-key-XYZ');
  check('key encrypted under the generated secret round-trips', (await acc.resolveAccount(first.account.id)).apiKey === 'client-key-XYZ');
  check('default account becomes the first registry account', (await acc.defaultAccountId()) === first.account.id);

  console.log('\nDrill: journey uses emails[] + fromDate, survives a clicks failure; cohort batches paginate');
  const drill = (await import('../api/drill.js')).default;
  const drillReq = (qs) => ({ url: `/api/drill?${qs}&key=correct-horse-battery`, headers: { host: 'x' } });
  calls.length = 0;
  let dr = fakeRes();
  await drill(drillReq('email=lead1@example.test'), dr);
  const clicksReq = calls.find((c) => c.name === 'hyros_get_lead_clicks')?.args.request;
  check('journey drill answers with the lead, sales and clicks', dr.code === 200 && dr.body?.journey?.lead?.email === 'lead1@example.test' && dr.body.journey.sales.length === 1 && dr.body.journey.clicks.length === 1, JSON.stringify(dr.body));
  check('clicks requested with emails: [email] (email is deprecated) + a fromDate', JSON.stringify(clicksReq?.emails) === '["lead1@example.test"]' && clicksReq?.email === undefined && /^\d{4}-\d{2}-\d{2}T/.test(clicksReq?.fromDate || ''), JSON.stringify(clicksReq));
  check('journey dates normalised (legacy click date EST -> -05:00, sale currency carried)', dr.body?.journey?.clicks[0]?.date === '2026-09-02T10:00:00-05:00' && dr.body.journey.sales[0].currency === 'USD' && dr.body.journey.sales[0].amount === 149, JSON.stringify([dr.body?.journey?.clicks, dr.body?.journey?.sales]));
  mock.failNext({ tool: 'hyros_get_lead_clicks', status: 500, body: 'clicks down' });
  dr = fakeRes();
  await drill(drillReq('email=lead1@example.test'), dr);
  check('a failed clicks call does not blank the journey; the reason is carried', dr.code === 200 && dr.body?.journey?.sales.length === 1 && dr.body.journey.clicks.length === 0 && /HTTP 500/.test(dr.body.journey.clicksError || ''), JSON.stringify(dr.body));
  mock.pages('hyros_get_sales', 6, 250);
  dr = fakeRes();
  await drill(drillReq('tags=@as-1&metric=sales'), dr);
  check('cohort sales paginate (4 × 250) and surface truncated', dr.code === 200 && dr.body?.records?.length === 1000 && dr.body.truncated === true && dr.body.cohortSize === 1, JSON.stringify([dr.body?.records?.length, dr.body?.truncated, dr.body?.cohortSize]));
  check('cohort sale records carry ISO dates + currency', /^\d{4}-\d{2}-\d{2}T/.test(dr.body?.records?.[0]?.date || '') && dr.body?.records?.[0]?.currency === 'USD', JSON.stringify(dr.body?.records?.[0]));
  mock.reset();
  check('accountFromReq: the legacy env id falls to the default', (await acc.accountFromReq({ url: '/api/data?account=env', headers: { host: 'x' } })) === first.account.id);
  const secrets = await setup.pendingSecrets();
  check('pending secrets readable for the hardening screen', /^[0-9a-f]{64}$/.test(secrets.ACCOUNT_KEY_SECRET) && /^[0-9a-f]{64}$/.test(secrets.CRON_SECRET));
  let h = await setup.harden();
  check('harden is a no-op until the env matches', h.done.ACCOUNT_KEY_SECRET === false && h.remaining.ACCOUNT_KEY_SECRET === true);
  process.env.ACCOUNT_KEY_SECRET = 'a-typo-not-the-generated-value';
  h = await setup.harden();
  check('a wrong env value never drops the KV copy', h.done.ACCOUNT_KEY_SECRET === false && h.remaining.ACCOUNT_KEY_SECRET === true);
  check('…and stored keys still decrypt via the KV fallback secret', (await acc.resolveAccount(first.account.id)).apiKey === 'client-key-XYZ');
  process.env.ACCOUNT_KEY_SECRET = secrets.ACCOUNT_KEY_SECRET;
  process.env.CRON_SECRET = secrets.CRON_SECRET;
  h = await setup.harden();
  check('matching env values drop both KV copies', h.done.ACCOUNT_KEY_SECRET && h.done.CRON_SECRET && !h.remaining.ACCOUNT_KEY_SECRET && !h.remaining.CRON_SECRET);
  check('keys decrypt under the env secret after hardening', (await acc.resolveAccount(first.account.id)).apiKey === 'client-key-XYZ');
  check('hardened state reports env sources', (await setup.setupState()).pendingSecrets === false && (await setup.setupState()).keySecret === 'env');
  check('signed cron accepted, unsigned refused when CRON_SECRET is set', auth.isCron({ headers: { authorization: `Bearer ${secrets.CRON_SECRET}` } }) === true && auth.isCron({ headers: { 'user-agent': 'vercel-cron/1.0' } }) === false);
  delete process.env.CRON_SECRET;
  check('without CRON_SECRET the Vercel cron UA is recognised', auth.isCron({ headers: { 'user-agent': 'vercel-cron/1.0' } }) === true && auth.isCron({ headers: { 'user-agent': 'curl/8' } }) === false);
  check('cron lock: first SET NX wins, second is refused', (await store.kvRaw(['SET', 'aihyros:cron:lock', '1', 'NX', 'EX', '3000'])) === 'OK' && (await store.kvRaw(['SET', 'aihyros:cron:lock', '1', 'NX', 'EX', '3000'])) === null);
  await setup.changePassword('new-password-12345');
  check('change password takes effect', (await auth.checkAccess(reqWith('new-password-12345'))).ok === true && (await auth.checkAccess(reqWith('correct-horse-battery'))).ok === false);
  const before = [...mem.keys()].filter((k) => k.startsWith('aihyros:')).length;
  const reset = await setup.factoryReset();
  check('factory reset wipes every app key and returns to needs_setup', before >= 3 && reset.deleted === before && reset.state === 'needs_setup' && [...mem.keys()].every((k) => !k.startsWith('aihyros:')), JSON.stringify({ before, deleted: reset.deleted, state: reset.state }));
  check('after reset the registry is empty', (await acc.listAccounts()).length === 0);
} finally {
  server.close();
}

console.log(failures ? `\n${failures} pipeline check(s) FAILED` : '\nAll pipeline checks passed.');
process.exit(failures ? 1 : 0);
