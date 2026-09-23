/**
 * Demo mode — a fully synthetic, PROFITABLE snapshot for live demos.
 *
 * Toggled by clicking the LIVE/SEED badge (flips to DEMO). Everything is
 * generated with the SAME math the real pipeline uses (derive/aggregate/
 * rollup from shared/metrics.js), so ads sum to ad sets, ad sets to
 * campaigns, and every derived metric reconciles — a demo that doesn't add
 * up gets caught. Deterministic seed: numbers are stable across reloads.
 *
 * Drill-downs in demo mode come from here too, never from the API, so no
 * real customer data can appear on screen during a demo.
 */
import { derive, aggregate, rollup, ADDITIVE } from './shared/metrics.js';

/* Deterministic RNG (mulberry32) so the demo is stable. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = [
  { id: '9001', name: 'Scale Ecom — Meta', type: 'FACEBOOK', traffic: 'facebook' },
  { id: '9002', name: 'Scale Ecom — Google', type: 'GOOGLE_V2', traffic: 'google_v2' },
];

/* Campaign profiles: [name, account idx, roas, dailySpend, adsets] */
const CAMPAIGNS = [
  ['Prospecting — Broad',        0, 3.4, 1450, ['Broad 18-54', 'Broad Stack Interests', 'Advantage+ Open']],
  ['Lookalike 1% Buyers',        0, 4.1,  980, ['LAL 1% Purchasers', 'LAL 1% High LTV']],
  ['Retargeting — 7 Day',        0, 6.2,  420, ['Site Visitors 7d', 'ATC Abandoners 7d']],
  ['Retargeting — 30 Day',       0, 4.8,  260, ['Engagers 30d', 'Video Viewers 75%']],
  ['Creative Testing',           0, 1.9,  340, ['UGC Test Pod', 'Static Test Pod']],
  ['Search — Brand',             1, 8.5,  310, ['Brand Exact', 'Brand + Reviews']],
  ['Search — Category KWs',      1, 2.6,  540, ['Category Exact', 'Category Phrase']],
  ['YouTube — Remarketing',      1, 3.1,  280, ['Site Remarketing', 'Customer Match']],
];

const AD_NAMES = ['UGC Hook — "I was skeptical"', 'Static — Bundle Offer', 'Founder Story 45s',
  'Testimonial Mashup', 'Problem/Solution 30s', 'Carousel — Best Sellers', 'Before & After',
  'Press Feature — Static'];

const FIRST = ['sarah', 'mike', 'jenna', 'carlos', 'emily', 'david', 'priya', 'tom', 'lena',
  'marcus', 'olivia', 'ryan', 'nadia', 'chris', 'amara', 'jake', 'sofia', 'ben', 'maya', 'liam'];
const LAST = ['mitchell', 'torres', 'chen', 'brooks', 'patel', 'nguyen', 'romano', 'silva',
  'novak', 'hayes', 'kim', 'foster', 'walsh', 'ortiz', 'reed'];
const DOMAINS = ['brightpeakfit.com', 'lumenandoak.com', 'nordicstride.co', 'wildbloomskin.com',
  'summitgearlab.com', 'aurastudio.io', 'oakandember.com', 'peakformwellness.com'];
const PRODUCTS = [['Performance Bundle', 189], ['Starter Kit', 89], ['Pro System', 349],
  ['Subscription — Monthly', 59], ['Gift Set', 129]];

export function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
export function jitter(r, v, pct = 0.25) { return v * (1 + (r() - 0.5) * 2 * pct); }
export const round2 = (v) => Math.round(v * 100) / 100;

export function ymd(d) { return d.toISOString().slice(0, 10); }
export function daysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; }

/** One ad's metrics for `days` of runtime under a campaign profile. */
function adMetrics(r, roas, spendShare, days) {
  const cost = round2(jitter(r, spendShare * days, 0.3));
  const cpm = jitter(r, 22, 0.3);
  const impressions = Math.round((cost / cpm) * 1000);
  const ctr = jitter(r, 1.7, 0.4) / 100;
  const clicks = Math.round(impressions * ctr);
  const revenue = round2(jitter(r, cost * roas, 0.35));
  const aov = jitter(r, 145, 0.2);
  const sales = Math.max(revenue > 0 ? 1 : 0, Math.round(revenue / aov));
  const leads = Math.round(clicks * jitter(r, 0.045, 0.4));
  const calls = Math.round(leads * 0.12);
  const recurringRevenue = round2(revenue * 0.18);
  return {
    cost, revenue, totalRevenue: round2(revenue + recurringRevenue),
    sales, leads, newLeads: Math.round(leads * 0.9), calls,
    qualifiedCalls: Math.round(calls * 0.7),
    clicks, impressions, newVisits: Math.round(clicks * 0.78),
    reported: round2(revenue * jitter(r, 0.72, 0.15)),
    uniqueCustomers: Math.round(sales * 0.85),
    recurringRevenue,
    refund: round2(revenue * jitter(r, 0.015, 0.5)),
    refundCount: Math.round(sales * 0.015),
    partialVideoViews: Math.round(impressions * 0.19),
    carts: Math.round(clicks * 0.11), atcEvents: Math.round(clicks * 0.11),
    purchasedCarts: sales,
  };
}

function buildRange(seed, days, label, start, end) {
  const r = rng(seed);
  const adsetRows = [];
  const adRows = [];

  CAMPAIGNS.forEach(([campName, acctIdx, roas, dailySpend], ci) => {
    const acct = ACCOUNTS[acctIdx];
    const perAdset = dailySpend / CAMPAIGNS[ci][4].length;
    CAMPAIGNS[ci][4].forEach((adsetName, si) => {
      const adsetId = `demo-${ci}-${si}`;
      const tag = `@demo-${ci}-${si}`;
      const adCount = 2 + Math.floor(r() * 2);
      const ads = [];
      for (let ai = 0; ai < adCount; ai += 1) {
        const m = adMetrics(r, roas, perAdset / adCount, days);
        ads.push(derive({
          id: `demo-${ci}-${si}-${ai}`,
          name: AD_NAMES[(ci * 3 + si * 2 + ai) % AD_NAMES.length],
          parentName: adsetName,
          parentId: adsetId,
          ...m,
        }));
      }
      adRows.push(...ads);
      // Ad set = exact sum of its ads (internally consistent).
      adsetRows.push({
        ...aggregate(ads, { id: adsetId, name: adsetName, parentName: null }),
        tag,
        _category: campName,
        _traffic: acct.traffic,
        _account: acct.id,
      });
    });
  });

  return { label, start, end, ...assembleLevels(adsetRows, adRows) };
}

/** Rollups + totals from an adset/ad base — shared by base build and re-attribution. */
function assembleLevels(adsetRows, adRows) {
  const acctName = new Map(ACCOUNTS.map((a) => [a.id, a.name]));
  const withTags = (rows, keyOf) => rows.map((row) => ({
    ...row,
    tags: [...new Set(adsetRows.filter((a) => keyOf(a) === row.id && a.tag).map((a) => a.tag))],
  }));

  return {
    levels: {
      traffic:  withTags(rollup(adsetRows, (x) => x._traffic, (id) => id), (a) => a._traffic),
      account:  withTags(rollup(adsetRows, (x) => x._account, (id) => acctName.get(id) || id), (a) => a._account),
      campaign: withTags(rollup(adsetRows, (x) => x._category, (id) => id), (a) => a._category),
      adset:    adsetRows,
      ad:       adRows,
    },
    totals: aggregate(adsetRows),
  };
}

/* ---------------- attribution models (demo) ---------------- *
 * "Custom HYROS" reassigns conversion credit the way a multi-touch model
 * would: last-click over-credits bottom-funnel (retargeting, brand search),
 * so the custom model shifts credit toward the prospecting that created the
 * customer. Credit moves — it is never invented: totals are normalized so
 * account-level revenue/sales match last-click exactly.
 */

const CUSTOM_FACTORS = {
  'Prospecting — Broad':   1.38,
  'Lookalike 1% Buyers':   1.22,
  'Retargeting — 7 Day':   0.62,
  'Retargeting — 30 Day':  0.70,
  'Creative Testing':      1.45,
  'Search — Brand':        0.55,
  'Search — Category KWs': 1.18,
  'YouTube — Remarketing': 0.80,
};

/* Credit-carrying fields move with the model; traffic (clicks, cost,
   impressions, leads) is what physically happened and never changes. */
const SHIFT_KEYS = ['revenue', 'totalRevenue', 'reported', 'sales', 'uniqueCustomers',
  'recurringRevenue', 'refund', 'refundCount', 'purchasedCarts'];
const SHIFT_INTS = new Set(['sales', 'uniqueCustomers', 'refundCount', 'purchasedCarts']);

function reattributeRange(block) {
  const catOfAdset = new Map(block.levels.adset.map((a) => [a.name, a._category]));
  const factorOf = (adsetName) => CUSTOM_FACTORS[catOfAdset.get(adsetName)] ?? 1;

  // Normalize so total credited revenue is conserved across models.
  const baseTotal = block.levels.ad.reduce((s, a) => s + (a.revenue || 0), 0);
  const scaledTotal = block.levels.ad.reduce((s, a) => s + (a.revenue || 0) * factorOf(a.parentName), 0);
  const k = scaledTotal ? baseTotal / scaledTotal : 1;

  const ads = block.levels.ad.map((a) => {
    const f = factorOf(a.parentName) * k;
    const out = { id: a.id, name: a.name, parentName: a.parentName };
    for (const key of ADDITIVE) if (a[key] !== undefined) out[key] = a[key];
    for (const key of SHIFT_KEYS) {
      if (out[key] === undefined) continue;
      out[key] = SHIFT_INTS.has(key) ? Math.round(out[key] * f) : round2(out[key] * f);
    }
    return derive(out);
  });

  const adsets = block.levels.adset.map((s) => ({
    ...aggregate(ads.filter((a) => a.parentName === s.name), { id: s.id, name: s.name, parentName: null }),
    tag: s.tag, _category: s._category, _traffic: s._traffic, _account: s._account,
  }));

  return { label: block.label, start: block.start, end: block.end, ...assembleLevels(adsets, ads) };
}

/** The "Custom HYROS" view of a demo snapshot. CRM records are shared. */
export function applyAttribution(base) {
  return {
    ...base,
    attributionModel: 'CUSTOM HYROS',
    ranges: Object.fromEntries(
      Object.entries(base.ranges).map(([key, blk]) => [key, reattributeRange(blk)])),
  };
}

/* ---------------- CRM ---------------- */

function person(r, i) {
  const first = FIRST[i % FIRST.length];
  const last = LAST[(i * 7) % LAST.length];
  return {
    email: `${first}.${last}@${pick(r, DOMAINS)}`,
    name: `${first} ${last}`,
  };
}

function buildCrm(seed) {
  const r = rng(seed);
  const leads = [];
  const sales = [];
  const calls = [];
  const subscriptions = [];

  for (let i = 0; i < 60; i += 1) {
    const p = person(r, i);
    const [ci, si] = [Math.floor(r() * CAMPAIGNS.length), 0];
    const camp = CAMPAIGNS[ci];
    const tag = `@demo-${ci}-${si}`;
    const joinedDays = Math.floor(r() * 28);
    const joined = daysAgo(joinedDays).toISOString();
    const src = {
      name: camp[4][0], tag, organic: false,
      ad: AD_NAMES[(ci * 3) % AD_NAMES.length], clickDate: joined,
    };
    const bought = r() < 0.42;
    const [prodName, price] = pick(r, PRODUCTS);
    const income = bought ? round2(price * (r() < 0.2 ? 2 : 1)) : 0;

    leads.push({
      id: p.email, email: p.email, name: p.name, joined,
      stage: bought ? 'Customer' : (r() < 0.3 ? 'Opportunity' : 'Lead'),
      stageDate: joined, consent: 'GRANTED',
      tags: ['!site', tag], phones: [],
      firstSource: src, lastSource: src, lastSourceDate: joined,
      income, hasAttribution: true,
    });

    if (bought) {
      sales.push({
        id: `demo-sale-${i}`, email: p.email, leadName: p.name,
        date: daysAgo(Math.max(0, joinedDays - 1)).toISOString(),
        amount: income, currency: 'USD', product: prodName,
        recurring: prodName.startsWith('Subscription'), refunded: false,
        firstSource: src.name, lastSource: src.name,
      });
    }
    if (r() < 0.22) {
      calls.push({
        id: `demo-call-${i}`, email: p.email, leadName: p.name,
        date: daysAgo(Math.max(0, joinedDays - 1)).toISOString(),
        name: 'Strategy Call', state: r() < 0.78 ? 'QUALIFIED' : 'NO_SHOW',
        qualified: r() < 0.78,
        firstSource: src.name, ad: src.ad, lastSource: src.name,
      });
    }
    if (bought && prodName.startsWith('Subscription')) {
      subscriptions.push({
        id: `demo-sub-${i}`, email: p.email, leadName: p.name,
        date: joined, name: 'Monthly Membership', price: 59,
        periodicity: 'MONTH', status: 'ACTIVE', provider: 'Stripe',
      });
    }
  }

  return {
    leads, sales, calls, subscriptions,
    stages: [
      { name: 'Lead', amount: 1240 }, { name: 'Opportunity', amount: 385 },
      { name: 'Customer', amount: 2210 }, { name: 'Churned', amount: 96 },
    ],
    // Same shape as the live pipeline's crm.sync: the demo lists are complete and fresh.
    sync: {
      incremental: false, leadsFetched: leads.length, stale: false,
      truncated: { leads: false, sales: false, calls: false, subscriptions: false },
    },
    totals: {
      leads: leads.length,
      attributed: leads.length,
      customers: leads.filter((l) => l.stage === 'Customer').length,
      income: leads.reduce((s, l) => s + l.income, 0),
      calls: calls.length,
      qualifiedCalls: calls.filter((c) => c.qualified).length,
      subscriptions: subscriptions.length,
    },
  };
}

/* Feature blocks (funnel, adltv, scale, health, …) are generated by each
 * feature's own demo.js — see public/features/<id>/demo.js and
 * shared/features.js applyDemoFeatures(). */

/* ---------------- public API ---------------- */

export function buildDemoSnapshot() {
  const today = ymd(new Date());
  const ranges = {
    today:     buildRange(11, 1,  'Today',        today, today),
    yesterday: buildRange(12, 1,  'Yesterday',    ymd(daysAgo(1)), ymd(daysAgo(1))),
    '7d':      buildRange(13, 7,  'Last 7 days',  ymd(daysAgo(6)), today),
    '30d':     buildRange(14, 30, 'Last 30 days', ymd(daysAgo(29)), today),
  };
  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    origin: 'demo',
    attributionModel: 'LAST_CLICK',
    settings: { model: 'LAST_CLICK', windowDays: 0, leadStage: [] },
    account: {
      email: 'demo@hyros.com', timezone: '-06:00', currency: 'USD', attributionWindowDefault: 7,
      managedBy: [{ accountId: 'agency-1', email: 'ops@growthlabs.agency', company: 'Growth Labs', status: 'APPROVED' }],
      clients: [],
    },
    adAccounts: ACCOUNTS.map(({ id, name, type }) => ({ id, name, type })),
    sourceCount: CAMPAIGNS.reduce((s, c) => s + c[4].length, 0),
    ranges,
    crm: buildCrm(21),
  };
}

/** Demo cohort for a drilled source — synthetic, no API call. */
export function demoCohort(row) {
  const r = rng((row.id || '').length * 977 + 5);
  const n = 8 + Math.floor(r() * 6);
  const leads = [];
  for (let i = 0; i < n; i += 1) {
    const p = person(r, i + 30);
    const joined = daysAgo(Math.floor(r() * 12)).toISOString();
    const src = { name: row.name, tag: row.tag || (row.tags || [])[0] || '@demo',
      organic: false, ad: pick(r, AD_NAMES), clickDate: joined };
    leads.push({
      email: p.email, name: p.name, joined,
      stage: r() < 0.4 ? 'Customer' : null,
      firstSource: src, lastSource: src, tags: ['!site', src.tag],
    });
  }
  return { ok: true, origin: 'demo', kind: 'leads', leads, truncated: false };
}

export function demoRecords(row, metric) {
  const cohort = demoCohort(row).leads;
  const r = rng((row.id || '').length * 613 + 9);
  const records = cohort
    .filter(() => r() < (metric === 'sales' ? 0.45 : 0.3))
    .map((l) => {
      const [prodName, price] = pick(r, PRODUCTS);
      return {
        date: l.joined, email: l.email,
        name: metric === 'sales' ? prodName : 'Strategy Call',
        amount: metric === 'sales' ? price : null,
        state: metric === 'sales' ? null : 'QUALIFIED',
        source: l.firstSource.name,
      };
    });
  return { ok: true, origin: 'demo', kind: metric, records, cohortSize: cohort.length, truncated: false };
}

export function demoJourney(email) {
  const r = rng(email.length * 131 + 3);
  const [prodName, price] = pick(r, PRODUCTS);
  const d3 = daysAgo(3), d2 = daysAgo(2), d0 = daysAgo(0);
  const camp = pick(r, CAMPAIGNS);
  const adset = camp[4][0];
  const ad = pick(r, AD_NAMES);
  return {
    ok: true, origin: 'demo',
    journey: {
      lead: { email, name: null, joined: d3.toISOString(), stage: 'Customer',
        firstSource: { name: adset, tag: '@demo', organic: false, ad, clickDate: d3.toISOString() },
        lastSource: null, tags: ['!site', '@demo'] },
      sales: [{ date: d0.toISOString(), amount: price, product: prodName,
        firstSource: adset, lastSource: adset, ad }],
      calls: [],
      journey: [
        { type: 'lead-stage', date: d0.toISOString(), name: 'Customer stage', keyword: 'Reached', extra: null, subNames: null },
        { type: 'sale', date: d0.toISOString(), name: prodName, keyword: 'Purchased', extra: `$${Math.round(price)}`, subNames: null },
        { type: 'opt-in', date: d2.toISOString(), name: 'store checkout — email captured', keyword: 'Opted in', extra: null, subNames: null },
        { type: 'sl', date: d3.toISOString(), name: adset, keyword: 'Clicked', extra: 'FACEBOOK', subNames: [ad] },
      ],
      clicks: [
        { date: d3.toISOString(), page: 'https://store.example/landing', previousUrl: 'https://l.facebook.com/', source: adset, platform: 'FACEBOOK' },
        { date: d2.toISOString(), page: 'https://store.example/products/best-sellers', previousUrl: 'https://store.example/landing', source: null, platform: null },
        { date: d0.toISOString(), page: 'https://store.example/checkout', previousUrl: 'https://store.example/products/best-sellers', source: null, platform: null },
      ],
    },
  };
}
