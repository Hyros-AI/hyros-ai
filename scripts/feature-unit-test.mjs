/**
 * Feature unit tests — pure-function and view/server checks that need no
 * MCP and no KV. Same `check()` style as pipeline-test.mjs; exits 1 on any
 * failure.
 *
 *   node scripts/feature-unit-test.mjs
 *
 * Covers: the Scale Advisor curve normaliser against the REST-documented
 * shape, cacCeiling handling, the "tool did not answer" card, stale
 * labelling; Tracking Health's budget check, reply-shape tolerance and the
 * warnings pill; the template / funnel / adltv views against every block
 * state; the manifest rule for live features without a server step.
 */
import { buildDemoSnapshot } from '../public/demo.js';
import { fmt, formatCell } from '../public/shared/metrics.js';
import { validateManifest } from '../public/shared/features.js';
import { normalizeCurve, build as buildScale } from '../public/features/scale/server.js';
import { demo as scaleDemo } from '../public/features/scale/demo.js';
import { render as renderScale, curveSvg } from '../public/features/scale/view.js';
import { build as buildHealth } from '../public/features/health/server.js';
import { demo as healthDemo } from '../public/features/health/demo.js';
import { render as renderHealth } from '../public/features/health/view.js';
import { render as renderTemplate } from '../public/features/_template/view.js';
import { build as buildTemplate } from '../public/features/_template/server.js';
import { demo as templateDemo } from '../public/features/_template/demo.js';
import { render as renderFunnel } from '../public/features/funnel/view.js';
import { render as renderAdltv } from '../public/features/adltv/view.js';
import { demo as adltvDemo } from '../public/features/adltv/demo.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`);
  if (!ok) failures += 1;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stubRoot = () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => null, dataset: {}, hidden: false });
const snap = buildDemoSnapshot();
fmt.cents = false;

/** A view ctx like the app builds; `seen` collects every kpis() call so tests can read tile values. */
function viewCtx(id, block, extra = {}) {
  const seen = [];
  return {
    seen,
    id, manifest: { id, name: id, description: 'd' }, root: stubRoot(), snapshot: snap, block,
    demo: true, account: null, range: '30d', level: 'campaign', fmt, esc,
    kpis: (list) => { seen.push(...list); return list.map((k) => `<div class="kpi">${esc(k.label)}: ${esc(k.value)} ${esc(k.sub || '')}</div>`).join(''); }, // like app.js kpiTiles: escaped text
    formatCell, note: () => {}, openJourney: () => {}, api: async () => ({ status: 200, body: {} }), selectView: () => {},
    ...extra,
  };
}
const renders = (fn, ctx) => { try { fn(ctx); return null; } catch (err) { return err; } };

/**
 * A server ctx with a recording callTool; `reply` decides what each tool
 * returns. `timeLeft` is a number or a function (to shrink the budget
 * mid-step); `timeouts` mirrors the runner's optional `ctx.timeouts`.
 */
function serverCtx({ reply = async () => ({}), timeLeft = 20000, env = {}, previous = null, timeouts, snapshot = snap } = {}) {
  const calls = [];
  const left = typeof timeLeft === 'function' ? timeLeft : () => timeLeft;
  return {
    calls,
    id: 'x', manifest: {},
    callTool: async (name, args, opts) => { calls.push({ name, args, opts }); return reply(name, args); },
    callToolPaged: async (name, args, opts) => { calls.push({ name, args, opts }); return []; },
    snapshot, previous, deadline: Date.now() + left(), timeLeft: left,
    log: () => {}, env, now: new Date('2026-09-14T12:00:00Z'),
    ...(timeouts ? { timeouts, slowTimeout: (m = 2000) => Math.max(1000, Math.min(timeouts.slow ?? 45000, left() - m)) } : {}),
  };
}

// ---------------------------------------------------------------------------
console.log('\nScale Advisor: normalizeCurve against the documented response');
const REST_EXAMPLE = {
  id: '23851234567890123', level: 'SOURCE_LINK', name: 'YT-LongForm-Founder',
  startDate: '2020-05-12', endDate: '2020-08-10', attributionModel: 'FIRST_CLICK', daysSampled: 84,
  cacCeiling: 52.0, ceilingBasis: 'CALLER_PROVIDED', ltvWindow: null,
  curve: [
    { spendPerDay: 812.40, days: 28, newCustomers: 594, avgCac: 38.29, marginalCac: null },
    { spendPerDay: 1490.10, days: 28, newCustomers: 941, avgCac: 44.33, marginalCac: 54.68 },
    { spendPerDay: 2274.75, days: 28, newCustomers: 1088, avgCac: 58.54, marginalCac: 149.46 },
  ],
  saturationPoint: { efficientSpendPerDay: 1490.10, saturatedSpendPerDay: 2274.75, reason: 'MARGINAL_CAC_ABOVE_CEILING' },
  notes: [],
};
{
  const c = normalizeCurve(REST_EXAMPLE, { id: 'x', name: 'meta name', level: 'SOURCE_LINK' });
  check('documented curve parses to >= 2 points', c.points.length === 3, JSON.stringify(c.points));
  check('spend read from spendPerDay', c.points[0]?.spend === 812.4, String(c.points[0]?.spend));
  check('customers read from newCustomers', c.points[0]?.customers === 594, String(c.points[0]?.customers));
  check('avgCac / marginalCac read (null marginal kept null)', c.points[0]?.avgCac === 38.29 && c.points[0]?.marginalCac === null && c.points[1]?.marginalCac === 54.68, JSON.stringify(c.points));
  check('days per bucket kept', c.points[0]?.days === 28, String(c.points[0]?.days));
  check('saturation read from saturatedSpendPerDay', c.saturationSpend === 2274.75, String(c.saturationSpend));
  check('efficient spend read from efficientSpendPerDay', c.efficientSpend === 1490.1, String(c.efficientSpend));
  check('saturation reason kept', c.saturationReason === 'MARGINAL_CAC_ABOVE_CEILING', String(c.saturationReason));
  check('ceilingBasis, ltvWindow, cacCeiling kept', c.ceilingBasis === 'CALLER_PROVIDED' && c.ltvWindow === null && c.ceiling === 52, JSON.stringify([c.ceilingBasis, c.ltvWindow, c.ceiling]));
  check('name comes from the reply when present', c.name === 'YT-LongForm-Founder', c.name);
  check('daysSampled and attributionModel kept', c.daysSampled === 84 && c.attributionModel === 'FIRST_CLICK');
  const ltv = normalizeCurve({ ...REST_EXAMPLE, cacCeiling: 61.2, ceilingBasis: 'LTV_BREAKEVEN', ltvWindow: '90_days' }, { id: 'x', level: 'SOURCE_LINK' });
  check('LTV_BREAKEVEN + ltvWindow kept', ltv.ceilingBasis === 'LTV_BREAKEVEN' && ltv.ltvWindow === '90_days');
  const wrapped = normalizeCurve({ request_id: 'r', result: REST_EXAMPLE }, { id: 'x', level: 'SOURCE_LINK' });
  check('REST envelope { result } is unwrapped', wrapped.points.length === 3, String(wrapped.points.length));
  const nullSat = normalizeCurve({ ...REST_EXAMPLE, saturationPoint: null }, { id: 'x', level: 'SOURCE_LINK' });
  check('saturationPoint null -> saturationSpend null', nullSat.saturationSpend === null && nullSat.efficientSpend === null);
  const acct = normalizeCurve({ ...REST_EXAMPLE, name: null, level: 'ACCOUNT', cacCeiling: null, ceilingBasis: null, saturationPoint: null, notes: ['LTV_CEILING_UNAVAILABLE'] }, { id: '9001', name: 'Meta', level: 'ACCOUNT' });
  check('account level: null name falls back to meta, ceiling null, notes kept', acct.name === 'Meta' && acct.ceiling === null && acct.notes[0] === 'LTV_CEILING_UNAVAILABLE', JSON.stringify(acct));
  const legacy = normalizeCurve({ curve: [{ dailySpend: 20, averageCac: 46, marginalCac: 56, customers: 1 }, { dailySpend: 40, averageCac: 52, marginalCac: 72, customers: 2 }], saturationPoint: { dailySpend: 40 } }, { id: 'x', level: 'SOURCE_LINK' });
  check('legacy keys (dailySpend/averageCac/customers) still parse', legacy.points.length === 2 && legacy.points[1].spend === 40 && legacy.points[1].customers === 2 && legacy.saturationSpend === 40, JSON.stringify(legacy));
  const junk = normalizeCurve('nope', { id: 'x', level: 'SOURCE_LINK' });
  check('non-object reply -> empty points, no throw', Array.isArray(junk.points) && junk.points.length === 0);
}

console.log('\nScale Advisor: build(ctx) request + budget rules');
{
  const c1 = serverCtx({ reply: async () => REST_EXAMPLE });
  const out = await buildScale(c1);
  const acctReq = c1.calls.find((c) => c.args.request.level === 'ACCOUNT')?.args.request;
  check('account call omits cacCeiling when HYROS_CAC_CEILING is unset', acctReq && !('cacCeiling' in acctReq), JSON.stringify(acctReq));
  check('every call uses a timeout <= 15 s', c1.calls.every((c) => (c.opts?.timeoutMs ?? 0) > 0 && c.opts.timeoutMs <= 15000), JSON.stringify(c1.calls.map((c) => c.opts)));
  check('block carries checkedAt (ISO) and window', /^\d{4}-\d{2}-\d{2}T/.test(out.checkedAt || '') && out.window?.start && out.window?.end, JSON.stringify([out.checkedAt, out.window]));
  check('one curve per call', Array.isArray(out.curves) && out.curves.length === c1.calls.length);

  const c2 = serverCtx({ reply: async () => REST_EXAMPLE, env: { HYROS_CAC_CEILING: '85' } });
  await buildScale(c2);
  check('account call passes cacCeiling when the env value is a positive number', c2.calls.find((c) => c.args.request.level === 'ACCOUNT')?.args.request.cacCeiling === 85);
  check('ad-set calls never pass cacCeiling (HYROS derives the LTV break-even)', c2.calls.filter((c) => c.args.request.level === 'SOURCE_LINK').every((c) => !('cacCeiling' in c.args.request)));
  for (const bad of ['0', '-5', 'abc', '']) {
    const c3 = serverCtx({ reply: async () => REST_EXAMPLE, env: { HYROS_CAC_CEILING: bad } });
    await buildScale(c3);
    check(`HYROS_CAC_CEILING=${JSON.stringify(bad)} -> cacCeiling omitted`, !('cacCeiling' in c3.calls.find((c) => c.args.request.level === 'ACCOUNT').args.request));
  }

  const spent = serverCtx({ timeLeft: 0 });
  const skipped = await buildScale(spent);
  check('spent budget: zero MCP calls', spent.calls.length === 0, String(spent.calls.length));
  check('spent budget, no previous: bare { skipped } marker', JSON.stringify(skipped) === '{"skipped":"time budget"}', JSON.stringify(skipped));
  const prev = { window: { start: '2026-06-01', end: '2026-08-29' }, checkedAt: '2026-08-29T10:00:00Z', curves: [{ id: 'a', level: 'ACCOUNT', points: [] }], stale: true, skipped: 'time budget' };
  const spent2 = serverCtx({ timeLeft: 0, previous: prev });
  const reused = await buildScale(spent2);
  check('spent budget with previous data: previous block kept, marked stale', reused.stale === true && reused.skipped === 'time budget' && reused.curves?.length === 1 && reused.checkedAt === prev.checkedAt, JSON.stringify(reused));

  const failing = serverCtx({ reply: async () => { throw new Error('Non-JSON response (HTTP 404)'); } });
  const errs = await buildScale(failing);
  check('a failing tool lands inside each curve as { error }, never throws', errs.curves.length > 0 && errs.curves.every((c) => /HTTP 404/.test(c.error)), JSON.stringify(errs.curves[0]));
}

console.log('\nScale Advisor: view states');
{
  const demoBlock = scaleDemo(snap);
  check('demo block uses the documented ceilingBasis enum', demoBlock.curves.every((c) => [null, 'CALLER_PROVIDED', 'LTV_BREAKEVEN'].includes(c.ceilingBasis)), JSON.stringify([...new Set(demoBlock.curves.map((c) => c.ceilingBasis))]));
  check('demo block is deterministic', JSON.stringify(scaleDemo(snap)) === JSON.stringify(demoBlock));
  check('demo block has >= 2 points per curve and a checkedAt', demoBlock.curves.every((c) => c.points.length >= 2) && Boolean(demoBlock.checkedAt));

  const allErr = viewCtx('scale', { window: { start: 'a', end: 'b' }, curves: [
    { id: '9001', name: 'Meta', level: 'ACCOUNT', points: [], notes: [], error: 'Non-JSON response (HTTP 404)' },
    { id: 'as-1', name: 'Broad <b>x</b>', level: 'SOURCE_LINK', points: [], notes: [], error: 'Non-JSON response (HTTP 404)' },
  ] });
  const e1 = renders(renderScale, allErr);
  check('all curves errored: renders', !e1, e1?.message);
  check('all curves errored: one clear "did not answer" card naming the HTTP status', /did not answer the CAC curve tool/.test(allErr.root.innerHTML) && /HTTP 404/.test(allErr.root.innerHTML) && /HYROS support/.test(allErr.root.innerHTML), allErr.root.innerHTML.slice(0, 300));
  check('all curves errored: does not say "Not enough data yet"', !/Not enough data yet/.test(allErr.root.innerHTML));
  check('all curves errored: the card appears once, not per entity', (allErr.root.innerHTML.match(/did not answer the CAC curve tool/g) || []).length === 1);

  const stale = viewCtx('scale', { ...demoBlock, stale: true, skipped: 'time budget' });
  const e2 = renders(renderScale, stale);
  check('stale block renders and says the curves are from a previous refresh', !e2 && /previous/i.test(stale.root.innerHTML), e2?.message || stale.root.innerHTML.slice(0, 200));
  check('stale block shows the previous check time via fmt.datetime', stale.root.innerHTML.includes(esc(fmt.datetime(demoBlock.checkedAt))), fmt.datetime(demoBlock.checkedAt));

  const mixed = viewCtx('scale', { ...demoBlock, curves: [demoBlock.curves[0], { id: 'z', name: 'Z', level: 'SOURCE_LINK', skipped: 'time budget' }] });
  renderScale(mixed);
  check('"Entities analyzed" does not count per-curve { skipped }', mixed.seen.find((k) => k.label === 'Entities analyzed')?.value === fmt.int(1), JSON.stringify(mixed.seen));
  const full = viewCtx('scale', demoBlock);
  renderScale(full);
  check('ceilingBasis and ltvWindow shown on the cards', /ltv breakeven/i.test(full.root.innerHTML) && /90 days/i.test(full.root.innerHTML));

  for (const blk of [{ skipped: 'time budget' }, { error: 'boom' }, {}]) {
    const c = viewCtx('scale', blk);
    const e = renders(renderScale, c);
    check(`scale view tolerates ${JSON.stringify(blk)}`, !e && c.root.innerHTML.length > 0, e?.message);
  }
}

// ---------------------------------------------------------------------------
console.log('\nScale: chart geometry and slow lane');
{
    const fmtStub = { money0: (n) => `$${Math.round(n)}`, money: (n) => `$${n}`, int: (n) => String(n) };
    const noCac = { points: [{ spend: 20, avgCac: null, marginalCac: null }, { spend: 40, avgCac: null, marginalCac: null }], ceiling: null, saturationSpend: null };
    check('curveSvg: spend points without CAC values draw nothing (no NaN geometry)', curveSvg(noCac, fmtStub) === '', JSON.stringify(curveSvg(noCac, fmtStub)).slice(0, 80));
    const withCac = { points: [{ spend: 20, avgCac: 40, marginalCac: null }, { spend: 40, avgCac: 50, marginalCac: 70 }], ceiling: null, saturationSpend: null };
    const svg = curveSvg(withCac, fmtStub);
    check('curveSvg: with CAC values the chart has no NaN coordinates and HTML labels', svg.includes('scale-plot') && !/NaN/.test(svg), svg.slice(0, 120));
    const slowCtx = serverCtx({ reply: async () => ({ curve: [] }), timeLeft: 60000, timeouts: { default: 15000, slow: 45000 }, snapshot: { adAccounts: [{ id: 'acc1', name: 'A', type: 'FACEBOOK' }], ranges: { '30d': { end: '2026-09-14', levels: { adset: [] } } } } });
    await buildScale(slowCtx);
    const curveCall = slowCtx.calls.find((c) => c.name === 'hyros_get_marginal_cac_curve');
    check('scale: the curve call rides the slow lane (45 s) when the runner offers it', curveCall?.opts?.timeoutMs === 45000, JSON.stringify(curveCall?.opts));
  }

{
  const spent = serverCtx({ timeLeft: 0 });
  const out = await buildHealth(spent);
  check('spent budget: zero MCP calls (no hyros_get_domains before the first check)', spent.calls.length === 0, spent.calls.map((c) => c.name).join(','));
  check('spent budget, no previous: bare { skipped } marker', JSON.stringify(out) === '{"skipped":"time budget"}', JSON.stringify(out));
  const prev = { ...healthDemo(), checkedAt: '2026-08-29T10:00:00Z' };
  const reused = await buildHealth(serverCtx({ timeLeft: 0, previous: { ...prev, stale: true, skipped: 'time budget' } }));
  check('spent budget with previous data: previous block kept, marked stale', reused.stale === true && reused.checkedAt === prev.checkedAt && reused.domains.length === 2, JSON.stringify(reused).slice(0, 200));

  const ok = serverCtx({ reply: async (name, args) => {
    if (name === 'hyros_get_domains') return ['a.test', 'b.test'];
    if (name === 'hyros_assert_script_presence_on_domain') { if (!args.request) throw new Error('hyros_assert_script_presence_on_domain: Missing required property: request'); return Object.fromEntries(args.request.domains.map((d) => [d, 'SCRIPT_FOUND'])); }
    return { result: [{ adName: 'x', valid: true }] };
  } });
  const good = await buildHealth(ok);
  const { siteOf, siteTargets } = await import('../public/features/health/server.js');
  check('siteOf: tracking CNAME -> registrable site domain', siteOf('data.bluebyartshop.com') === 'bluebyartshop.com' && siteOf('h.lacademie-de-la-haute-performance.com') === 'lacademie-de-la-haute-performance.com', [siteOf('data.bluebyartshop.com'), siteOf('h.lacademie-de-la-haute-performance.com')].join(','));
  check('siteOf: second-level public suffixes survive (co.uk, com.mx)', siteOf('track.shop.co.uk') === 'shop.co.uk' && siteOf('tienda.com.mx') === 'tienda.com.mx', [siteOf('track.shop.co.uk'), siteOf('tienda.com.mx')].join(','));
  check('siteOf: an apex passes through; scheme and path are stripped', siteOf('scale-ecom.com') === 'scale-ecom.com' && siteOf('https://data.x.com/path') === 'x.com', siteOf('https://data.x.com/path'));
  const targets = siteTargets(['data.a.com', 'go.a.com', 'data.b.io']);
  check('siteTargets: apex and www together per site, deduplicated, each tagged with its tracking domain', targets.map((t) => t.url).join(' ') === 'https://a.com/ https://www.a.com/ https://b.io/ https://www.b.io/' && targets[0].trackingDomain === 'data.a.com', JSON.stringify(targets));
  const seven = siteTargets(['d1.a.com', 'd2.b.com', 'd3.c.com', 'd4.d.com', 'd5.e.com', 'd6.f.com', 'd7.g.com']);
  check('siteTargets: the cap drops whole sites, never a site\'s www half', siteTargets(['d1.a.com', 'd2.b.com', 'd3.c.com']).length === 6 && seven.length === 12 && seven.filter((t) => /\/\/www\./.test(t.url)).length === 6 && !seven.some((t) => t.trackingDomain === 'd7.g.com'), JSON.stringify(seven.map((t) => t.url)));
  const scriptCalls = ok.calls.filter((c) => c.name === 'hyros_assert_script_presence_on_domain').map((c) => c.args.request.domains.join(' '));
  check('script check fetches the sites in batches of 3 (the MCP limit), covering apex and www', scriptCalls.join(' | ') === 'https://a.test/ https://www.a.test/ https://b.test/ | https://www.b.test/', scriptCalls.join(' | '));
  check('happy path: domains, scripts, no errors', good.domains.length === 2 && Object.keys(good.scripts).length === 4 && good.sites.length === 4 && good.errors.length === 0, JSON.stringify(good));
  check('every call uses a timeout <= 15 s', ok.calls.every((c) => (c.opts?.timeoutMs ?? 0) > 0 && c.opts.timeoutMs <= 15000), JSON.stringify(ok.calls.map((c) => [c.name, c.opts])));

  const odd = serverCtx({ reply: async (name) => (name === 'hyros_get_domains' ? ['a.test'] : ['SCRIPT_FOUND']) });
  const shape = await buildHealth(odd);
  check('assert tool returning a non-map records "script: unexpected reply shape"', shape.errors.includes('script: unexpected reply shape'), JSON.stringify(shape.errors));
  check('...and scripts stays an empty map', JSON.stringify(shape.scripts) === '{}');
  const wrapped = serverCtx({ reply: async (name) => (name === 'hyros_get_domains' ? { result: ['a.test'] } : { result: { 'https://a.test/': 'SCRIPT_FOUND' } }) });
  const w = await buildHealth(wrapped);
  check('assert tool { result: map } is unwrapped', w.scripts['https://a.test/'] === 'SCRIPT_FOUND' && w.errors.length === 0, JSON.stringify(w));
}

console.log('\nTracking Health: checks contract (per-check status, cost order, slow script timeout, stale carry-forward)');
{
  const CHECKS = ['domains', 'script', 'params'];
  const replyOk = async (name, args) => {
    if (name === 'hyros_get_domains') return ['a.test', 'b.test'];
    if (name === 'hyros_assert_script_presence_on_domain') { if (!args.request) throw new Error('hyros_assert_script_presence_on_domain: Missing required property: request'); return Object.fromEntries(args.request.domains.map((d) => [d, 'SCRIPT_FOUND'])); }
    return { result: [{ adName: 'x', valid: true }] };
  };
  const timeoutErr = (ms) => Object.assign(new Error(`MCP call timed out after ${ms}ms`), { code: 'timeout' });
  const scriptCall = (c) => c.calls.find((x) => x.name === 'hyros_assert_script_presence_on_domain');
  const SLOW = { default: 15000, slow: 45000 };
  const scriptTimesOut = (name, args) => (name === 'hyros_assert_script_presence_on_domain' ? Promise.reject(timeoutErr(45000)) : replyOk(name, args));

  const okCtx = serverCtx({ reply: replyOk, timeLeft: 60000, timeouts: SLOW });
  const good = await buildHealth(okCtx);
  check('happy path: checks.{domains,script,params} all ok', CHECKS.every((k) => good.checks?.[k]?.status === 'ok'), JSON.stringify(good.checks));
  check('every check records ms', CHECKS.every((k) => Number.isFinite(good.checks[k].ms)), JSON.stringify(good.checks));
  check('params check names the channels it checked', JSON.stringify(good.checks.params.channels) === JSON.stringify({ SEARCH: 'ok', PERFORMANCE_MAX: 'ok' }), JSON.stringify(good.checks.params));
  const order = okCtx.calls.map((c) => c.name);
  const firstScript = order.indexOf('hyros_assert_script_presence_on_domain');
  check('cost order: domains, then both param checks, then the script batches last', order[0] === 'hyros_get_domains' && firstScript > 1 && order.slice(1, firstScript).every((n) => n === 'hyros_check_tracking_parameters_for_integrations') && order.slice(firstScript).every((n) => n === 'hyros_assert_script_presence_on_domain'), order.join(','));
  check('script check uses ctx.timeouts.slow when the runner offers it', scriptCall(okCtx)?.opts?.timeoutMs === 45000, JSON.stringify(scriptCall(okCtx)?.opts));
  check('cheap checks keep the default (<= 15 s) timeout', okCtx.calls.filter((c) => c.name !== 'hyros_assert_script_presence_on_domain').every((c) => c.opts?.timeoutMs > 0 && c.opts.timeoutMs <= 15000));
  check('legacy keys still present (domains, scripts, trackingParams, errors)', Array.isArray(good.domains) && good.scripts && Array.isArray(good.trackingParams) && Array.isArray(good.errors));

  const capCtx = serverCtx({ reply: replyOk, timeLeft: 30000, timeouts: SLOW });
  await buildHealth(capCtx);
  check('slow timeout never exceeds timeLeft() - 2 s', scriptCall(capCtx)?.opts?.timeoutMs === 28000, JSON.stringify(scriptCall(capCtx)?.opts));
  const legacyRunner = serverCtx({ reply: replyOk, timeLeft: 60000 });
  await buildHealth(legacyRunner);
  check('runner without ctx.timeouts: script check stays on the 15 s contract', scriptCall(legacyRunner)?.opts?.timeoutMs === 15000, JSON.stringify(scriptCall(legacyRunner)?.opts));

  const to = serverCtx({ reply: scriptTimesOut, timeLeft: 60000, timeouts: SLOW });
  const timedOut = await buildHealth(to);
  check('script tool timeout -> checks.script failed', timedOut.checks.script.status === 'failed', JSON.stringify(timedOut.checks.script));
  check('...with a human reason naming the seconds', /HYROS did not answer within 45s/.test(timedOut.checks.script.reason) && /every domain live/.test(timedOut.checks.script.reason), timedOut.checks.script.reason);
  check('...params still ok, domains still ok', timedOut.checks.params.status === 'ok' && timedOut.checks.domains.status === 'ok');
  check('...errors[] carries the same reason for compatibility', timedOut.errors.some((e) => /^script: HYROS did not answer/.test(e)), JSON.stringify(timedOut.errors));
  check('...skips are not counted as errors', timedOut.errors.length === 1, JSON.stringify(timedOut.errors));

  let afterDomains = false;
  const tight = serverCtx({ reply: async (name, args) => { afterDomains = true; return replyOk(name, args); }, timeLeft: () => (afterDomains ? 1000 : 20000) });
  const tightOut = await buildHealth(tight);
  check('budget gone after domains: only hyros_get_domains was called', tight.calls.map((c) => c.name).join(',') === 'hyros_get_domains', tight.calls.map((c) => c.name).join(','));
  check('...params skipped with reason "time budget"', tightOut.checks.params.status === 'skipped' && tightOut.checks.params.reason === 'time budget', JSON.stringify(tightOut.checks.params));
  check('...script skipped with reason "time budget"', tightOut.checks.script.status === 'skipped' && tightOut.checks.script.reason === 'time budget', JSON.stringify(tightOut.checks.script));
  check('...domains ok', tightOut.checks.domains.status === 'ok');

  let made = 0;
  const under8 = serverCtx({ reply: async (name, args) => { made += 1; return replyOk(name, args); }, timeLeft: () => (made >= 3 ? 7000 : 20000), timeouts: SLOW });
  const under8Out = await buildHealth(under8);
  check('under 8 s left before the script check: skipped, not started', under8Out.checks.script.status === 'skipped' && under8Out.checks.script.reason === 'time budget' && !scriptCall(under8), JSON.stringify(under8Out.checks.script));

  const emptyParams = await buildHealth(serverCtx({ reply: async (name, args) => (name === 'hyros_check_tracking_parameters_for_integrations' ? { result: [] } : replyOk(name, args)) }));
  check('params ran and found nothing -> status empty', emptyParams.checks.params.status === 'empty', JSON.stringify(emptyParams.checks.params));
  const noGoogle = serverCtx({ reply: replyOk, snapshot: { ...snap, adAccounts: [{ id: '1', name: 'Meta', type: 'FACEBOOK' }] } });
  const ng = await buildHealth(noGoogle);
  check('no Google ad account -> params skipped, no params call', ng.checks.params.status === 'skipped' && /Google/.test(ng.checks.params.reason) && !noGoogle.calls.some((c) => c.name === 'hyros_check_tracking_parameters_for_integrations'), JSON.stringify(ng.checks.params));
  const noDomains = await buildHealth(serverCtx({ reply: async (name, args) => (name === 'hyros_get_domains' ? [] : replyOk(name, args)) }));
  check('no verified domains -> domains empty, script skipped with reason', noDomains.checks.domains.status === 'empty' && noDomains.checks.script.status === 'skipped' && /no verified domains/.test(noDomains.checks.script.reason), JSON.stringify(noDomains.checks));
  const domFail = await buildHealth(serverCtx({ reply: async (name, args) => (name === 'hyros_get_domains' ? Promise.reject(new Error('HTTP 500')) : replyOk(name, args)) }));
  check('domains tool failure -> domains failed with the message, script skipped', domFail.checks.domains.status === 'failed' && /HTTP 500/.test(domFail.checks.domains.reason) && domFail.checks.script.status === 'skipped', JSON.stringify(domFail.checks));
  const oneChannelFails = await buildHealth(serverCtx({ reply: async (name, args) => (name === 'hyros_check_tracking_parameters_for_integrations' && args.request.type === 'SEARCH' ? Promise.reject(new Error('boom')) : replyOk(name, args)) }));
  check('one channel fails, the other answers -> params ok, per-channel status, one error', oneChannelFails.checks.params.status === 'ok' && oneChannelFails.checks.params.channels.SEARCH === 'failed' && oneChannelFails.checks.params.channels.PERFORMANCE_MAX === 'ok' && oneChannelFails.errors.some((e) => /^params SEARCH: boom/.test(e)), JSON.stringify([oneChannelFails.checks.params, oneChannelFails.errors]));
  const shapeErr = await buildHealth(serverCtx({ reply: async (name, args) => (name === 'hyros_assert_script_presence_on_domain' ? ['SCRIPT_FOUND'] : replyOk(name, args)) }));
  check('unreadable script reply -> checks.script failed "unexpected reply shape"', shapeErr.checks.script.status === 'failed' && /unexpected reply shape/.test(shapeErr.checks.script.reason), JSON.stringify(shapeErr.checks.script));

  const prevScripts = { 'https://a.test/': 'SCRIPT_FOUND', 'https://b.test/': 'SCRIPT_NOT_FOUND' };
  const prevSites = [{ url: 'https://a.test/', trackingDomain: 'a.test' }, { url: 'https://b.test/', trackingDomain: 'b.test' }];
  const previous = { checkedAt: '2026-08-29T10:00:00Z', domains: ['a.test', 'b.test'], sites: prevSites, scripts: prevScripts, trackingParams: [], errors: [], checks: { domains: { status: 'ok' }, script: { status: 'ok', ms: 9000 }, params: { status: 'empty' } } };
  const carry = await buildHealth(serverCtx({ reply: scriptTimesOut, timeLeft: 60000, timeouts: SLOW, previous }));
  check('script failed + previous completed check: previous per-URL results carried forward', JSON.stringify(carry.scripts) === JSON.stringify(prevScripts), JSON.stringify(carry.scripts));
  check('…and the previous site mapping comes with them, so the grouped view survives', JSON.stringify(carry.sites) === JSON.stringify(prevSites), JSON.stringify(carry.sites));
  check('...marked stale with the previous checkedAt, status still failed', carry.checks.script.status === 'failed' && carry.checks.script.stale === true && carry.checks.script.checkedAt === previous.checkedAt, JSON.stringify(carry.checks.script));
  check('...the block itself is fresh (no block-level stale marker, new checkedAt)', carry.stale === undefined && carry.checkedAt !== previous.checkedAt);
  let after2 = false;
  const carrySkip = await buildHealth(serverCtx({ reply: async (name, args) => { after2 = true; return replyOk(name, args); }, timeLeft: () => (after2 ? 1000 : 20000), previous: { ...previous, stale: true, skipped: 'time budget' } }));
  check('script skipped + previous (even runner-marked stale): results carried forward, status skipped', carrySkip.checks.script.status === 'skipped' && carrySkip.checks.script.stale === true && JSON.stringify(carrySkip.scripts) === JSON.stringify(prevScripts), JSON.stringify(carrySkip.checks.script));
  const carryTwice = await buildHealth(serverCtx({ reply: scriptTimesOut, timeLeft: 60000, timeouts: SLOW, previous: carry }));
  check('carrying forward twice keeps the ORIGINAL checkedAt', carryTwice.checks.script.checkedAt === previous.checkedAt && JSON.stringify(carryTwice.scripts) === JSON.stringify(prevScripts), JSON.stringify(carryTwice.checks.script));
  const legacyPrev = { checkedAt: '2026-08-29T10:00:00Z', domains: ['a.test'], scripts: { 'https://a.test/': 'SCRIPT_FOUND' }, trackingParams: [], errors: [] };
  const carryLegacy = await buildHealth(serverCtx({ reply: scriptTimesOut, timeLeft: 60000, timeouts: SLOW, previous: legacyPrev }));
  check('previous block from before `checks` existed (has scripts): still carried forward', carryLegacy.checks.script.stale === true && JSON.stringify(carryLegacy.scripts) === JSON.stringify(legacyPrev.scripts), JSON.stringify(carryLegacy.checks.script));
  const noCarry = await buildHealth(serverCtx({ reply: scriptTimesOut, timeLeft: 60000, timeouts: SLOW, previous: { ...previous, scripts: {}, checks: { ...previous.checks, script: { status: 'failed', reason: 'x' } } } }));
  check('previous without a completed script check: nothing carried, scripts stays {}', JSON.stringify(noCarry.scripts) === '{}' && noCarry.checks.script.stale === undefined, JSON.stringify(noCarry.checks.script));
}

console.log('\nTracking Health: view');
{
  const h = healthDemo();
  const withWarn = viewCtx('health', h, { snapshot: { ...snap, adAccounts: [{ id: '9006', name: 'Reddit <x>', type: 'REDDIT' }, { id: '9001', name: 'Meta', type: 'FACEBOOK' }],
    warnings: [{ adAccountId: '9006', name: 'Reddit <x>', type: 'REDDIT', level: null, error: 'no report level for REDDIT', kind: 'unsupported' }] } });
  const e = renders(renderHealth, withWarn);
  check('ad account in snapshot.warnings gets a pill with the warning kind', !e && /skipped: unsupported/.test(withWarn.root.innerHTML), e?.message || withWarn.root.innerHTML.slice(0, 200));
  check('warning pill and names are escaped', !/<x>/.test(withWarn.root.innerHTML) && /Reddit &lt;x&gt;/.test(withWarn.root.innerHTML));
  const noWarn = viewCtx('health', h, { snapshot: { ...snap, warnings: [] } });
  renderHealth(noWarn);
  check('no warnings -> no skipped pill', !/skipped:/.test(noWarn.root.innerHTML));
  for (const blk of [{ skipped: 'time budget' }, { error: 'boom' }, {}, { ...h, stale: true, skipped: 'time budget' }]) {
    const c = viewCtx('health', blk);
    const err = renders(renderHealth, c);
    check(`health view tolerates ${JSON.stringify(Object.keys(blk))}`, !err && c.root.innerHTML.length > 0, err?.message);
    if (blk.stale) check('health stale block says "previous"', /previous/i.test(c.root.innerHTML));
  }
}

console.log('\nTracking Health: view says what each check did');
{
  const base = { checkedAt: '2026-09-14T12:00:00Z', domains: ['a.test', 'b.test'], scripts: {}, trackingParams: [], errors: [] };
  const OK = { status: 'ok', ms: 412 };
  const withGoogle = { ...snap, adAccounts: [{ id: '9002', name: 'G', type: 'GOOGLE' }], warnings: [] };
  const noGoogle = { ...snap, adAccounts: [{ id: '9001', name: 'Meta', type: 'FACEBOOK' }], warnings: [] };
  const tile = (c, label) => c.seen.find((k) => k.label === label) || {};
  /** The HTML with every element carrying a `sub` class (incl. kpi-sub) removed — what is left is normal-size text. */
  const outsideSub = (html) => html.replace(/<(\w+)[^>]*class="[^"]*sub[^"]*"[^>]*>[\s\S]*?<\/\1>/g, '');
  const render = (block, snapshot = withGoogle) => { const c = viewCtx('health', block, { snapshot }); const err = renders(renderHealth, c); return { c, err, html: c.root.innerHTML }; };

  const sk = render({ ...base, checks: { domains: OK, script: { status: 'skipped', reason: 'time budget' }, params: { status: 'skipped', reason: 'time budget' } } });
  check('skipped: renders', !sk.err, sk.err?.message);
  check('KPI "Script present": "—" with sub "skipped: time budget"', tile(sk.c, 'Script present').value === '—' && tile(sk.c, 'Script present').sub === 'skipped: time budget', JSON.stringify(tile(sk.c, 'Script present')));
  check('KPI "Ads missing tracking params": "—" with sub "skipped: time budget"', tile(sk.c, 'Ads missing tracking params').value === '—' && tile(sk.c, 'Ads missing tracking params').sub === 'skipped: time budget', JSON.stringify(tile(sk.c, 'Ads missing tracking params')));
  check('script panel: "Skipped this refresh (time budget) — press Refresh again"', /Skipped this refresh \(time budget\) — press Refresh again/.test(sk.html), sk.html.slice(0, 200));
  check('params panel: skipped, and never "No ads reported"', (sk.html.match(/Skipped this refresh \(time budget\)/g) || []).length === 2 && !/No ads reported/.test(sk.html));
  check('KPI "Check errors" is 0 — skips are not errors', tile(sk.c, 'Check errors').value === fmt.int(0), JSON.stringify(tile(sk.c, 'Check errors')));

  const reason = 'HYROS did not answer within 45s (the check fetches every domain live)';
  const fl = render({ ...base, errors: [`script: ${reason}`, 'params SEARCH: boom <x>'], checks: { domains: OK, script: { status: 'failed', reason, ms: 45001 }, params: { status: 'failed', reason: 'SEARCH: boom <x>', channels: { SEARCH: 'failed', PERFORMANCE_MAX: 'skipped' } } } });
  check('failed: renders', !fl.err, fl.err?.message);
  check('KPI "Check errors": value 2, sub names the first error', tile(fl.c, 'Check errors').value === fmt.int(2) && /^script: HYROS did not answer/.test(tile(fl.c, 'Check errors').sub || ''), JSON.stringify(tile(fl.c, 'Check errors')));
  check('KPI "Script present": "—" with sub "failed: <short reason>"', tile(fl.c, 'Script present').value === '—' && tile(fl.c, 'Script present').sub === 'failed: HYROS did not answer within 45s', JSON.stringify(tile(fl.c, 'Script present')));
  check('KPI "Ads missing tracking params": "—" with sub "failed: …"', tile(fl.c, 'Ads missing tracking params').value === '—' && /^failed: SEARCH: boom/.test(tile(fl.c, 'Ads missing tracking params').sub || ''), JSON.stringify(tile(fl.c, 'Ads missing tracking params')));
  const visible = outsideSub(fl.html);
  check('every error is listed OUTSIDE any .sub element (normal size), escaped', visible.includes(esc(reason)) && visible.includes('boom &lt;x&gt;') && !/<x>/.test(fl.html), visible.slice(0, 300));
  check('a visible "Check errors" list with a .pill.bad per check name', /Check errors/.test(visible) && /class="pill bad">script</.test(visible) && /class="pill bad">params SEARCH</.test(visible), visible.slice(0, 300));
  check('script panel: "Check failed: <reason>"', /Check failed: HYROS did not answer within 45s/.test(fl.html));
  check('params panel: "Check failed: <reason>", never "No ads reported"', /Check failed: SEARCH: boom &lt;x&gt;/.test(fl.html) && !/No ads reported/.test(fl.html));

  const em = render({ ...base, checks: { domains: OK, script: OK, params: { status: 'empty', ms: 300, channels: { SEARCH: 'empty', PERFORMANCE_MAX: 'empty' } } } });
  check('params empty: "No ads reported by the check in the last hour" — only then', /No ads reported by the check in the last hour/.test(em.html) && tile(em.c, 'Ads missing tracking params').value === '—', em.html.slice(0, 100));
  const ng = render({ ...base, scripts: { 'https://a.test/': 'SCRIPT_FOUND' }, checks: { domains: OK, script: OK, params: { status: 'skipped', reason: 'no Google ad accounts connected' } } }, noGoogle);
  check('no Google ad account: "No Google ad accounts connected — nothing to check", no skip banner', /No Google ad accounts connected — nothing to check/.test(ng.html) && !/Skipped this refresh/.test(ng.html) && !/No ads reported/.test(ng.html), ng.html.slice(0, 100));
  const gSkip = render({ ...base, checks: { domains: OK, script: OK, params: { status: 'skipped', reason: 'time budget' } } }, noGoogle);
  check('no Google ad account wins over a skipped params check', /No Google ad accounts connected/.test(gSkip.html));
  const nd = render({ ...base, domains: [], checks: { domains: { status: 'empty', ms: 90 }, script: { status: 'skipped', reason: 'no verified domains' }, params: OK } });
  check('no verified domains: KPI sub + panel say so', tile(nd.c, 'Script present').sub === 'no verified domains' && /No verified domains on this account — add one in HYROS/.test(nd.html), JSON.stringify(tile(nd.c, 'Script present')));

  const stale = render({ ...base, scripts: { 'https://a.test/': 'SCRIPT_FOUND', 'https://b.test/': 'SCRIPT_NOT_FOUND' }, errors: [`script: ${reason}`], checks: { domains: OK, script: { status: 'failed', reason, ms: 45001, stale: true, checkedAt: '2026-08-29T10:00:00Z' }, params: OK } });
  check('carried-forward scripts: rows render with a "previous check · <date>" pill', /class="pill">previous check · /.test(stale.html) && stale.html.includes(esc(fmt.datetime('2026-08-29T10:00:00Z'))) && /script not found/.test(stale.html), stale.html.slice(0, 200));
  check('...and the panel still says the check failed this refresh', /Check failed: HYROS did not answer/.test(stale.html));

  const good = render({ ...base, scripts: { 'https://a.test/': 'SCRIPT_FOUND', 'https://b.test/': 'SCRIPT_NOT_FOUND' }, trackingParams: [{ type: 'SEARCH', rows: [{ adName: 'x', valid: false, missing: ['gclid'] }] }, { type: 'PERFORMANCE_MAX', rows: [{ adName: 'y', valid: true }] }], checks: { domains: OK, script: OK, params: { ...OK, channels: { SEARCH: 'ok', PERFORMANCE_MAX: 'ok' } } } });
  check('all ok: "Script present" = "1 / 2", sub names the URLs checked (legacy block without sites)', tile(good.c, 'Script present').value === '1 / 2' && /2 URLs checked/.test(tile(good.c, 'Script present').sub), JSON.stringify(tile(good.c, 'Script present')));
  check('all ok: params sub names the channels checked', /checked: SEARCH, PERFORMANCE_MAX/.test(tile(good.c, 'Ads missing tracking params').sub), JSON.stringify(tile(good.c, 'Ads missing tracking params')));
  check('all ok: no "Check errors" panel, no skipped/failed wording', !/<h3>Check errors<\/h3>/.test(good.html) && !/Skipped this refresh|Check failed/.test(good.html));
  const mixed = render({ ...good.c.block, checks: { ...good.c.block.checks, params: { status: 'ok', ms: 1, channels: { SEARCH: 'ok', PERFORMANCE_MAX: 'skipped' } } } });
  check('mixed channels: sub says which ran and which did not', tile(mixed.c, 'Ads missing tracking params').sub === 'SEARCH checked · PERFORMANCE_MAX skipped', JSON.stringify(tile(mixed.c, 'Ads missing tracking params')));

  const legacy = render({ ...base, scripts: { 'https://a.test/': 'SCRIPT_FOUND' }, errors: ['params SEARCH: skipped (time budget)'] });
  check('block from before `checks` existed still renders with sensible tiles', !legacy.err && tile(legacy.c, 'Script present').value === '1 / 1', legacy.err?.message || JSON.stringify(tile(legacy.c, 'Script present')));

  const demoBlock = healthDemo(snap);
  const d = render(demoBlock, snap);
  check('demo block carries checks (all ok) and renders "1 / 2" sites with the script', ['domains', 'script', 'params'].every((k) => demoBlock.checks?.[k]?.status === 'ok') && !d.err && tile(d.c, 'Script present').value === '1 / 2', d.err?.message || JSON.stringify(demoBlock.checks));
  check('demo block is deterministic (no clock beyond today\'s date)', JSON.stringify(healthDemo(snap)) === JSON.stringify(demoBlock) && /T08:00:00\.000Z$/.test(demoBlock.checkedAt), demoBlock.checkedAt);
  check('demo block shows no skip/fail wording and no errors panel', !/Skipped this refresh|Check failed|<h3>Check errors<\/h3>/.test(d.html));
}

// ---------------------------------------------------------------------------
console.log('\nTemplate, Funnel, Ad LTV: block states');
{
  const tDemo = templateDemo(snap);
  for (const blk of [{ skipped: 'time budget' }, { error: 'boom' }, {}, { ...tDemo, stale: true, skipped: 'time budget' }, tDemo]) {
    const c = viewCtx('my-feature', blk);
    const err = renders(renderTemplate, c);
    check(`template view tolerates ${JSON.stringify(Object.keys(blk))}`, !err && c.root.innerHTML.length > 0, err?.message);
    if (blk.stale) check('template stale block says "previous"', /previous/i.test(c.root.innerHTML));
    if (blk.error) check('template error block shows the error', /boom/.test(c.root.innerHTML));
    if (blk.skipped && !blk.stale) check('template skipped block names the reason', /time budget/.test(c.root.innerHTML));
  }
  const tSpent = serverCtx({ timeLeft: 0 });
  const tOut = await buildTemplate(tSpent);
  check('template server: zero calls + bare marker on a spent budget', tSpent.calls.length === 0 && tOut.skipped === 'time budget', JSON.stringify(tOut));

  for (const blk of [{ error: 'boom' }, { skipped: 'time budget' }, {}]) {
    const c = viewCtx('funnel', blk);
    const err = renders(renderFunnel, c);
    check(`funnel view tolerates ${JSON.stringify(blk)}`, !err && c.root.innerHTML.length > 0, err?.message);
  }
  const aDemo = adltvDemo(snap);
  const evil = { ...aDemo, rows: aDemo.rows.map((r, i) => (i === 0 ? { ...r, name: 'Top <img src=x onerror=alert(1)>', ltv60: 1e9 } : r)) };
  const a = viewCtx('adltv', evil);
  const aErr = renders(renderAdltv, a);
  const sub = a.seen.find((k) => k.label === 'Highest 60-day LTV')?.sub || '';
  check('adltv: KPI sub is passed raw (kpis() escapes it) and renders escaped', !aErr && sub === 'Top <img src=x onerror=alert(1)>' && a.root.innerHTML.includes('&lt;img') && !a.root.innerHTML.includes('<img'), aErr?.message || sub);
  for (const blk of [{ error: 'boom' }, { skipped: 'time budget' }, {}]) {
    const c = viewCtx('adltv', blk);
    const err = renders(renderAdltv, c);
    check(`adltv view tolerates ${JSON.stringify(blk)}`, !err && c.root.innerHTML.length > 0, err?.message);
  }
}

// ---------------------------------------------------------------------------
console.log('\nManifest rule: live tabs need a server step');
{
  const base = { id: 'xx', name: 'X', tab: 'X', version: '1.0.0', description: 'd' };
  check('mode live without server is rejected (the tab could never show)', validateManifest({ ...base, mode: 'live', server: false, needs: ['ranges.30d'] }, 'xx').length > 0);
  check('mode both with demo but without server is rejected', validateManifest({ ...base, mode: 'both', demo: true, server: false, needs: ['ranges.30d'] }, 'xx').length > 0);
  check('mode both with demo + server is valid', validateManifest({ ...base, mode: 'both', demo: true, server: true }, 'xx').length === 0, validateManifest({ ...base, mode: 'both', demo: true, server: true }, 'xx').join('; '));
  check('mode demo without server is valid', validateManifest({ ...base, mode: 'demo', demo: true, server: false }, 'xx').length === 0);
}

console.log('\nHealth: "not found" is cross-checked against tracked visits');
{
  const leads = [{ id: 'L1', email: 'a@x.test' }, { id: 'L2', email: 'b@x.test' }, { email: 'no-id@x.test' }];
  const snapWithLeads = { ...snap, crm: { ...(snap.crm || {}), leads } };
  const replyWith = (clicks) => async (name, args) => {
    if (name === 'hyros_get_domains') return ['data.a.test', 'data.b.test'];
    if (name === 'hyros_assert_script_presence_on_domain') return Object.fromEntries(args.request.domains.map((d) => [d, /b\.test/.test(d) ? 'SCRIPT_NOT_FOUND' : 'SCRIPT_FOUND']));
    if (name === 'hyros_get_lead_clicks') return clicks(args);
    return { result: [] };
  };
  const vctx = serverCtx({ snapshot: snapWithLeads, reply: replyWith(() => ({ result: [{ page: 'https://www.b.test/landing?x=1' }, { page: 'https://other.test/' }], nextPageId: null })) });
  const blk = await buildHealth(vctx);
  const clickCall = vctx.calls.find((c) => c.name === 'hyros_get_lead_clicks');
  check('a "not found" site triggers one hyros_get_lead_clicks call for the recent leads\' ids', Boolean(clickCall) && JSON.stringify(clickCall.args.request.leadIds) === '["L1","L2"]' && /^\d{4}-\d{2}-\d{2}$/.test(clickCall.args.request.fromDate || ''), JSON.stringify(clickCall?.args));
  check('visited hosts are recorded without www, deduplicated', JSON.stringify(blk.visitedHosts) === '["b.test","other.test"]', JSON.stringify(blk.visitedHosts));
  check('checks.visits is ok', blk.checks?.visits?.status === 'ok', JSON.stringify(blk.checks?.visits));

  const allFound = serverCtx({ snapshot: snapWithLeads, reply: async (name, args) => (name === 'hyros_get_domains' ? ['data.a.test'] : name === 'hyros_assert_script_presence_on_domain' ? Object.fromEntries(args.request.domains.map((d) => [d, 'SCRIPT_FOUND'])) : { result: [] }) });
  const af = await buildHealth(allFound);
  check('every site found: no lead-clicks call, visits skipped', !allFound.calls.some((c) => c.name === 'hyros_get_lead_clicks') && af.checks?.visits?.status === 'skipped', JSON.stringify(af.checks?.visits));

  const noLeads = serverCtx({ snapshot: { ...snap, crm: { leads: [] } }, reply: replyWith(() => ({ result: [] })) });
  const nl = await buildHealth(noLeads);
  check('no recent leads: visits skipped, no call', !noLeads.calls.some((c) => c.name === 'hyros_get_lead_clicks') && /no recent leads/.test(nl.checks?.visits?.reason || ''), JSON.stringify(nl.checks?.visits));

  const boom = serverCtx({ snapshot: snapWithLeads, reply: replyWith(() => { throw new Error('clicks down'); }) });
  const bm = await buildHealth(boom);
  check('a failing clicks call is a failed visits check, never a failed refresh', bm.checks?.visits?.status === 'failed' && Array.isArray(bm.visitedHosts) && bm.visitedHosts.length === 0, JSON.stringify(bm.checks?.visits));

  const OKc = { status: 'ok', ms: 1 };
  const block = {
    checkedAt: '2026-09-30T12:00:00Z', domains: ['data.a.test', 'data.b.test', 'data.c.test'],
    sites: [
      { url: 'https://a.test/', trackingDomain: 'data.a.test' }, { url: 'https://www.a.test/', trackingDomain: 'data.a.test' },
      { url: 'https://b.test/', trackingDomain: 'data.b.test' }, { url: 'https://www.b.test/', trackingDomain: 'data.b.test' },
      { url: 'https://c.test/', trackingDomain: 'data.c.test' }, { url: 'https://www.c.test/', trackingDomain: 'data.c.test' },
    ],
    scripts: { 'https://a.test/': 'SCRIPT_FOUND', 'https://www.a.test/': 'SCRIPT_FOUND', 'https://b.test/': 'SCRIPT_NOT_FOUND', 'https://www.b.test/': 'SCRIPT_NOT_FOUND', 'https://c.test/': 'TIMEOUT_ERROR', 'https://www.c.test/': 'TIMEOUT_ERROR' },
    visitedHosts: ['b.test'], trackingParams: [], errors: [],
    checks: { domains: OKc, script: OKc, params: { status: 'skipped', reason: 'no Google ad accounts connected' }, visits: OKc },
  };
  const c = viewCtx('health', block);
  const err = renders(renderHealth, c);
  const html = c.root.innerHTML;
  check('view: renders', !err, err?.message);
  check('view: "not found" but visits tracked is an amber pill, not an error', /class="pill warn">not detected · visits tracked</.test(html), html.slice(0, 200));
  check('view: a timeout is amber "couldn\'t check", not "not found"', /class="pill warn">couldn&#39;t check \(timeout\)</.test(html) || /class="pill warn">couldn't check \(timeout\)</.test(html), html.slice(0, 200));
  check('view: no red "script not found" pill when every miss is explained', !/class="pill bad">script not found</.test(html));
  const tileScript = c.seen.find((k) => k.label === 'Script present') || {};
  check('view: "Script present" counts visited sites as working and leaves timeouts out (2 / 2)', tileScript.value === '2 / 2', JSON.stringify(tileScript));
}


console.log('\nHealth: visits cross-check edge cases (QA)');
{
  const OKc = { status: 'ok', ms: 1 };
  const siteBlock = (scripts, visitedHosts, extraChecks = {}) => ({
    checkedAt: '2026-09-30T12:00:00Z', domains: ['data.a.test', 'data.b.test'],
    sites: [
      { url: 'https://a.test/', trackingDomain: 'data.a.test' }, { url: 'https://www.a.test/', trackingDomain: 'data.a.test' },
      { url: 'https://b.test/', trackingDomain: 'data.b.test' }, { url: 'https://www.b.test/', trackingDomain: 'data.b.test' },
    ],
    scripts, visitedHosts, trackingParams: [], errors: [],
    checks: { domains: OKc, script: OKc, params: { status: 'skipped', reason: 'no Google ad accounts connected' }, visits: OKc, ...extraChecks },
  });
  const tileOf = (block) => { const c = viewCtx('health', block); renders(renderHealth, c); return { tile: c.seen.find((k) => k.label === 'Script present') || {}, html: c.root.innerHTML }; };

  const allTimeout = tileOf(siteBlock({ 'https://a.test/': 'TIMEOUT_ERROR', 'https://www.a.test/': 'TIMEOUT_ERROR', 'https://b.test/': 'TIMEOUT_ERROR', 'https://www.b.test/': 'TIMEOUT_ERROR' }, []));
  check('every site timed out: tile is "—", never a green 0 / 0', allTimeout.tile.value === '—' && allTimeout.tile.cls !== 'good', JSON.stringify(allTimeout.tile));
  check('...and its sub says the sites could not be checked', /couldn.t be checked/.test(allTimeout.tile.sub || ''), JSON.stringify(allTimeout.tile));

  const visitedOnly = tileOf(siteBlock({ 'https://a.test/': 'SCRIPT_FOUND', 'https://www.a.test/': 'SCRIPT_FOUND', 'https://b.test/': 'SCRIPT_NOT_FOUND', 'https://www.b.test/': 'SCRIPT_NOT_FOUND' }, ['b.test']));
  check('a visited-only site keeps the tile neutral, not green', visitedOnly.tile.value === '2 / 2' && visitedOnly.tile.cls === '', JSON.stringify(visitedOnly.tile));

  const sub = tileOf(siteBlock({ 'https://a.test/': 'SCRIPT_FOUND', 'https://www.a.test/': 'SCRIPT_FOUND', 'https://b.test/': 'SCRIPT_NOT_FOUND', 'https://www.b.test/': 'SCRIPT_NOT_FOUND' }, ['shop.b.test']));
  check('visits on a subdomain (shop.b.test) count for the site b.test', /class="pill warn">not detected · visits tracked</.test(sub.html), sub.html.slice(0, 120));
  const notSub = tileOf(siteBlock({ 'https://a.test/': 'SCRIPT_FOUND', 'https://www.a.test/': 'SCRIPT_FOUND', 'https://b.test/': 'SCRIPT_NOT_FOUND', 'https://www.b.test/': 'SCRIPT_NOT_FOUND' }, ['notb.test']));
  check('...but a different domain ending in the same letters (notb.test) does not', /class="pill bad">script not found</.test(notSub.html));

  check('checks panel names the visits check', /recent visits/.test(visitedOnly.html));
  const quiet = tileOf(siteBlock({ 'https://a.test/': 'SCRIPT_FOUND', 'https://www.a.test/': 'SCRIPT_FOUND', 'https://b.test/': 'SCRIPT_FOUND', 'https://www.b.test/': 'SCRIPT_FOUND' }, [], { visits: { status: 'skipped', reason: 'every checked URL has the script' } }));
  check('visits skipped because every URL has the script is a neutral pill, not amber', !/class="pill warn">skipped<\/span><code>recent visits/.test(quiet.html) && /class="pill ">skipped<\/span><code>recent visits/.test(quiet.html), quiet.html.match(/<span class="pill[^"]*">skipped<\/span><code>recent visits/)?.[0]);

  const leads = [{ id: 'old', joined: '2026-09-01' }, { id: 'mid', joined: '2026-09-10' }, { id: 'new', joined: '2026-09-02', lastSourceDate: '2026-09-29' }];
  const pages = [];
  const pctx = serverCtx({ snapshot: { ...snap, crm: { leads } }, reply: async (name, args) => {
    if (name === 'hyros_get_domains') return ['data.b.test'];
    if (name === 'hyros_assert_script_presence_on_domain') return Object.fromEntries(args.request.domains.map((d) => [d, 'SCRIPT_NOT_FOUND']));
    if (name === 'hyros_get_lead_clicks') { pages.push(args.request.pageId || null); return args.request.pageId === 'p2' ? { result: [{ page: 'https://b.test/x' }], nextPageId: null } : { result: [{ page: 'https://x.test/' }], nextPageId: 'p2' }; }
    return { result: [] };
  } });
  const pb = await buildHealth(pctx);
  const first = pctx.calls.find((c) => c.name === 'hyros_get_lead_clicks');
  check('leads are read newest activity first (last source date, else joined)', JSON.stringify(first?.args.request.leadIds) === '["new","mid","old"]', JSON.stringify(first?.args.request.leadIds));
  check('clicks are paged with nextPageId', JSON.stringify(pages) === '[null,"p2"]' && JSON.stringify(pb.visitedHosts) === '["b.test","x.test"]', JSON.stringify([pages, pb.visitedHosts]));
}


console.log(failures ? `\n${failures} feature unit test(s) FAILED` : '\nAll feature unit tests passed.');
process.exit(failures ? 1 : 0);
