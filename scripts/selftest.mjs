/**
 * Verifies the metric engine against REAL numbers read off a live HYROS
 * Performance Report screen (2026-08-13..19, Traffic source
 * level, Last Click). If HYROS changes a definition, these fail loudly.
 */
import { readFile } from 'node:fs/promises';
import { CATALOG, ADDITIVE, DEFAULT_KEYS, derive, aggregate, rollup } from '../public/shared/metrics.js';

let failures = 0;
const approx = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

function check(name, actual, expected, tol) {
  const ok = typeof expected === 'number' ? approx(actual, expected, tol) : actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
  if (!ok) failures += 1;
}

console.log('\nHYROS UI parity — Total row (from the real report screen)');
{
  const total = derive({
    cost: 4129.58, revenue: 560291.77, reported: 900.00,
    clicks: 3054, impressions: 0, sales: 732, leads: 0, calls: 0,
  });
  check('Profit             = 556,162.19', total.profit, 556162.19);
  check('Reported Vs Rev    = 559,391.77', total.reportedVsRevenue, 559391.77);
  check('ROI                = 13,467.77%', total.roi, 13467.77, 0.02);
  check('ROAS               = 135.68', total.roas, 135.68, 0.005);
}

console.log('\nAPI docs parity — ROAS counts recurring revenue (GET /attribution/roas example)');
{
  const row = derive({ cost: 2792.40, revenue: 8200, recurringRevenue: 1350, totalRevenue: 9550 });
  check('ROAS = total_revenue / cost = 3.42', row.roas, 3.42, 0.005);
  const legacy = derive({ cost: 100, revenue: 300 });
  check('ROAS falls back to revenue when totalRevenue is absent', legacy.roas, 3);
  const zeroed = derive({ cost: 100, revenue: 300, totalRevenue: 0 });
  check('ROAS falls back to revenue when totalRevenue is zeroed', zeroed.roas, 3);
}

console.log('\nHYROS UI parity — "meta" row (zero attributed revenue)');
{
  const meta = derive({ cost: 4129.58, revenue: 0, reported: 0, clicks: 2378, impressions: 0 });
  check('Profit             = -4,129.58', meta.profit, -4129.58);
  check('ROI                = -100.00%', meta.roi, -100);
  check('ROAS               = 0', meta.roas, 0);
}

console.log('\nDivide-by-zero safety');
{
  const zero = derive({ cost: 0, revenue: 0, impressions: 0, clicks: 0, leads: 0, sales: 0 });
  check('ROAS null when cost 0', zero.roas, null);
  check('ROI  null when cost 0', zero.roi, null);
  check('CTR  null when imps 0', zero.ctr, null);
  check('CPL  null when leads 0', zero.cpl, null);
  check('Profit still computes', zero.profit, 0);
}

console.log('\nRollup: derived metrics are RE-derived, never averaged');
{
  const children = [
    derive({ cost: 100, revenue: 300, impressions: 1000, clicks: 10 }),
    derive({ cost: 300, revenue: 300, impressions: 1000, clicks: 90 }),
  ];
  const parent = aggregate(children);
  check('cost sums            = 400', parent.cost, 400);
  check('revenue sums         = 600', parent.revenue, 600);
  // Averaging the children's ROAS (3.0, 1.0) would give 2.0 — the wrong answer.
  check('ROAS re-derived      = 1.5', parent.roas, 1.5);
  check('CTR  re-derived      = 5.00%', parent.ctr, 5);
}

console.log('\nSeed snapshot integrity (synthetic, generated from public/demo.js)');
{
  const seed = JSON.parse(await readFile(new URL('../data/seed.json', import.meta.url), 'utf8'));
  const block = seed.ranges['7d'];
  const { adset, ad, campaign, traffic, account } = block.levels;

  check('schema 2', seed.schema, 2);
  check('adset rows present', adset.length > 0, true);
  check('ad rows present', ad.length > 0, true);
  check('campaign rows present', campaign.length > 0, true);
  check('two traffic sources', traffic.length, 2);
  check('two ad accounts', account.length, 2);
  check('ads carry parentId', ad.every((r) => r.parentId), true);

  const adsetCost = adset.reduce((s, r) => s + r.cost, 0);
  const campCost = campaign.reduce((s, r) => s + r.cost, 0);
  const trafficCost = traffic.reduce((s, r) => s + r.cost, 0);
  check('campaign rollup preserves total cost', campCost, adsetCost, 0.05);
  check('traffic rollup preserves total cost', trafficCost, adsetCost, 0.05);
  check('7d total cost = adset cost', block.totals.cost, adsetCost, 0.05);

  // Every ad-set must resolve to a real source category, or Campaign is wrong.
  const uncategorised = campaign.find((c) => c.id === 'Uncategorised');
  check('no uncategorised ad sets', uncategorised === undefined, true);

  const attributed = seed.crm.leads.filter((l) => l.hasAttribution).length;
  check('leads carry click attribution', attributed > 0, true);
  check('income joined from sales', seed.crm.totals.income > 0, true);

  // No real customer data may ever be baked in.
  const text = JSON.stringify(seed);
  check('seed carries no real-account markers', /camel@hyros|locafy|viralstocks/.test(text), false);
}

console.log('\nColumn catalog');
{
  const keys = CATALOG.map((c) => c.k);
  check('no duplicate keys', new Set(keys).size, keys.length);
  const fields = CATALOG.map((c) => c.f);
  check('no duplicate API fields', new Set(fields).size, fields.length);
  check('every default key exists in catalog', DEFAULT_KEYS.every((k) => keys.includes(k)), true);
  check('additive list matches catalog flags', ADDITIVE.length, CATALOG.filter((c) => c.a === 's').length);

  // Rollups: derived metrics compute, non-aggregatable stay absent
  const children = [
    derive({ cost: 100, revenue: 500, sales: 2, clicks: 40, newVisits: 10 }),
    derive({ cost: 100, revenue: 100, sales: 2, clicks: 10, newVisits: 10 }),
  ];
  const parent = aggregate(children);
  check('AOV re-derived at rollup   = 150', parent.averageOrderValue, 150);
  check('CVR re-derived at rollup   = 8%', parent.cvr, 8);
  check('Cost/New Visit re-derived  = 10', parent.costPerNewVisit, 10);
  check('LTV absent at rollup (non-agg)', parent.ltv90Days === undefined, true);
  check('native value survives derive', derive({ cost: 10, leads: 2, costPerLead: 99 }).costPerLead, 99);
}

console.log('\nTimezones the API may send (userProfile.timezone is a free string)');
{
  const { parseTimezone, ymdInTz, addDays } = await import('../api/_dates.js');
  const { buildRanges } = await import('../api/_snapshot.js');
  const at = new Date('2026-09-15T03:30:00Z');
  check('-05:00 shifts the day back', buildRanges(at, '-05:00').today.start, '2026-09-14');
  check('America/New_York honoured (EDT in September)', buildRanges(at, 'America/New_York').today.start, '2026-09-14');
  check('UTC stays on the UTC day', buildRanges(at, 'UTC').today.start, '2026-09-15');
  check('GMT-5 form', ymdInTz(at, 'GMT-5'), '2026-09-14');
  check('bare -5 form', ymdInTz(at, '-5'), '2026-09-14');
  check('+05:30 rolls forward', ymdInTz(at, '+05:30'), '2026-09-15');
  check('Asia/Kolkata rolls forward', ymdInTz(at, 'Asia/Kolkata'), '2026-09-15');
  check('Mars/Olympus falls back to UTC', buildRanges(at, 'Mars/Olympus').today.start, '2026-09-15');
  check('Mars/Olympus is reported as not understood', parseTimezone('Mars/Olympus'), null);
  check('empty timezone is reported as not understood', parseTimezone(''), null);
  check('numeric offset parses to minutes', parseTimezone('-05:00')?.minutes, -300);
  check('IANA parses as iana', parseTimezone('Europe/Madrid')?.kind, 'iana');
  check('30d window is 30 days wide', buildRanges(at, 'UTC')['30d'].start, addDays('2026-09-15', -29));

  const { dayStart, dayEnd } = await import('../api/_dates.js');
  check('dayStart with a numeric offset', dayStart('2026-09-14', '-05:00'), '2026-09-14T00:00:00-05:00');
  check('dayEnd with a numeric offset', dayEnd('2026-09-14', '-05:00'), '2026-09-14T23:59:59-05:00');
  check('dayStart with UTC', dayStart('2026-09-14', 'UTC'), '2026-09-14T00:00:00+00:00');
  check('dayStart with an IANA zone carries no offset', dayStart('2026-09-14', 'America/New_York'), '2026-09-14T00:00:00');
  check('dayEnd with an unknown zone carries no offset', dayEnd('2026-09-14', 'Mars/Olympus'), '2026-09-14T23:59:59');
  const noon = new Date('2026-09-14T12:00:00Z');
  check('dayEnd of today is the current local time (the report rejects a future bound)', dayEnd('2026-09-14', '-05:00', noon), '2026-09-14T07:00:00-05:00');
  check('dayEnd of a past day is untouched by now', dayEnd('2026-09-13', '-05:00', noon), '2026-09-13T23:59:59-05:00');
  check('dayEnd of today in UTC', dayEnd('2026-09-14', 'UTC', noon), '2026-09-14T12:00:00+00:00');
  check('dayEnd of today in an IANA zone: local wall clock, no offset', dayEnd('2026-09-13', 'America/New_York', new Date('2026-09-14T02:30:00Z')), '2026-09-13T22:30:00');
  check('dayEnd of a day after today (clock skew) also clamps to now', dayEnd('2026-09-15', '-05:00', noon), '2026-09-14T07:00:00-05:00');
}

console.log('\nLegacy dates (docs: sales/calls/subscriptions use EEE MMM dd HH:mm:ss zzz yyyy)');
{
  const { parseHyrosDate } = await import('../api/_dates.js');
  check('ISO input passes through', parseHyrosDate('2026-09-05T12:00:00-05:00'), '2026-09-05T12:00:00-05:00');
  check('doc example ART -> -03:00', parseHyrosDate('Thu Nov 17 10:51:54 ART 2022'), '2022-11-17T10:51:54-03:00');
  check('doc example UTC', parseHyrosDate('Thu Jul 02 01:10:33 UTC 2026'), '2026-07-02T01:10:33+00:00');
  check('EST / PDT abbreviations', `${parseHyrosDate('Wed Sep 02 10:00:00 EST 2026')} ${parseHyrosDate('Wed Sep 02 10:00:00 PDT 2026')}`, '2026-09-02T10:00:00-05:00 2026-09-02T10:00:00-07:00');
  check('GMT+02:00 style zone', parseHyrosDate('Thu Nov 17 10:51:54 GMT+02:00 2022'), '2022-11-17T10:51:54+02:00');
  check('unknown zone uses the account offset', parseHyrosDate('Thu Nov 17 10:51:54 XYZ 2022', '-05:00'), '2022-11-17T10:51:54-05:00');
  check('unknown zone, no fallback: local time, no offset', parseHyrosDate('Thu Nov 17 10:51:54 XYZ 2022'), '2022-11-17T10:51:54');
  check('single-digit day is zero-padded', parseHyrosDate('Thu Jul 2 01:10:33 UTC 2026'), '2026-07-02T01:10:33+00:00');
  check('garbage is null', parseHyrosDate('yesterday-ish'), null);
  check('null is null', parseHyrosDate(null), null);
  check('empty is null', parseHyrosDate(''), null);
}

console.log('\nDemo drills (client-side, public/demo.js)');
{
  const { demoCohort, demoRecords, demoJourney } = await import('../public/demo.js');
  const cohort = demoCohort({ id: 'adset-1', name: 'Broad — Prospecting', tag: '@broad' });
  check('demo cohort has leads', cohort.leads.length >= 8, true);
  const sales = demoRecords({ id: 'adset-1', name: 'Broad — Prospecting' }, 'sales');
  check('demo sales records carry amounts', sales.records.every((r) => r.amount > 0), true);
  const j = demoJourney('someone@example.test');
  check('demo journey has a sale', j.journey.sales[0].amount > 0, true);
}

console.log('\nFormatting: money follows the account currency');
{
  const { fmt } = await import('../public/shared/metrics.js');
  const was = { cents: fmt.cents, currency: fmt.currency };
  fmt.cents = true; fmt.currency = 'USD';
  check('fmt.money follows the account currency: USD', fmt.money(357.04), '$357.04');
  fmt.currency = 'EUR';
  check('fmt.money follows the account currency: EUR', fmt.money(357.04), '€357.04');
  check('fmt.money keeps the sign in front of the symbol', fmt.money(-96.45), '-€96.45');
  fmt.currency = 'XYZ';
  check('fmt.money with an unknown code prefixes the code', fmt.money(1234.5).startsWith('XYZ') && fmt.money(1234.5).endsWith('1,234.50'), true);
  fmt.cents = false; fmt.currency = 'USD';
  check('fmt.money hides cents on the demo', fmt.money(1234.5), '$1,235');
  fmt.cents = true;
  check('fmt.currencyCode accepts ISO codes only', [fmt.currencyCode('eur'), fmt.currencyCode('MXN'), fmt.currencyCode('<img src=x>'), fmt.currencyCode(null), fmt.currencyCode('US')].join(','), 'EUR,MXN,USD,USD,USD');
  fmt.currency = '<img src=x onerror=alert(1)>';
  check('fmt.money never emits an unvalidated currency string', fmt.money(5).includes('<'), false);
  check('fmt.moneyIn ignores a malformed per-record code', fmt.moneyIn(5, '<b>').includes('<'), false);
  fmt.cents = true; fmt.currency = 'EUR';
  check('fmt.moneyIn formats a record in its own currency', fmt.moneyIn(288, 'USD'), '$288.00');
  check('fmt.moneyIn falls back to the account currency', fmt.moneyIn(288, null), '€288.00');
  check('fmt.moneyIn leaves the account currency untouched afterwards', fmt.money(1), '€1.00');
  fmt.cents = was.cents; fmt.currency = was.currency;
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
