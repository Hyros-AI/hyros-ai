/**
 * Metric definitions, the full HYROS column catalog, and level rollups.
 *
 * Single source of truth: imported by the serverless snapshot builder AND by
 * the browser, so a client-side filter recomputes totals exactly the way the
 * server did.
 *
 * Core formulas were reverse-checked against a real HYROS Performance Report
 * screen (2026-08-13..19):
 *   revenue 560,291.77  reported 900.00  ->  Reported Vs Revenue 559,391.77
 *   meta: cost 4,129.58, revenue 0       ->  profit -4,129.58, ROI -100.00%
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * THE CATALOG — every metric the HYROS attribution report can return, mapped
 * from the MCP `fields` enum to its response key. Verified empirically that
 * the `fields` param drives computation: requested fields populate (0 when no
 * data), unrequested ones come back null.
 *
 *  k    row key (API response key; `reported` maps from REPORTED_RESULT)
 *  f    MCP fields enum value
 *  l    column label
 *  t    money | int | pct | ratio
 *  g    selector group
 *  a    aggregation: 's' additive (sum on rollup) · 'd' derived (re-derive
 *       from additive parts) · null non-aggregatable (native rows only —
 *       rolled-up Campaign/Traffic/Account rows show "—")
 */
export const CATALOG = [
  // Core
  { k: 'clicks',            f: 'CLICKS',             l: 'Clicks',            t: 'int',   g: 'Core', a: 's' },
  { k: 'cost',              f: 'COST',               l: 'Cost',              t: 'money', g: 'Core', a: 's' },
  { k: 'totalRevenue',      f: 'TOTAL_REVENUE',      l: 'Total Revenue',     t: 'money', g: 'Core', a: 's' },
  { k: 'revenue',           f: 'REVENUE',            l: 'Revenue',           t: 'money', g: 'Core', a: 's' },
  { k: 'profit',            f: 'PROFIT',             l: 'Profit',            t: 'money', g: 'Core', a: 'd', tone: true },
  { k: 'reported',          f: 'REPORTED_RESULT',    l: 'Reported',          t: 'money', g: 'Core', a: 's' },
  { k: 'reportedVsRevenue', f: 'REPORTED_VS_REVENUE',l: 'Reported Vs Rev',   t: 'money', g: 'Core', a: 'd', tone: true },
  { k: 'shopReportedResult',f: 'SHOP_REPORTED_RESULT',l: 'Shop Reported',    t: 'money', g: 'Core', a: 's' },
  { k: 'sales',             f: 'SALES',              l: 'Sales',             t: 'int',   g: 'Core', a: 's' },
  { k: 'uniqueSales',       f: 'UNIQUE_SALES',       l: 'Unique Sales',      t: 'int',   g: 'Core', a: 's' },
  { k: 'roi',               f: 'ROI',                l: 'ROI',               t: 'pct',   g: 'Core', a: 'd', tone: true },
  { k: 'roas',              f: 'ROAS',               l: 'ROAS',              t: 'ratio', g: 'Core', a: 'd' },
  { k: 'leads',             f: 'LEADS',              l: 'Leads',             t: 'int',   g: 'Core', a: 's' },
  { k: 'newLeads',          f: 'NEW_LEADS',          l: 'New Leads',         t: 'int',   g: 'Core', a: 's' },
  { k: 'leadsOptins',       f: 'LEADS_OPTINS',       l: 'Opt-ins',           t: 'int',   g: 'Core', a: 's' },
  { k: 'impressions',       f: 'IMPRESSIONS',        l: 'Impressions',       t: 'int',   g: 'Core', a: 's' },
  { k: 'ctr',               f: 'CTR',                l: 'CTR',               t: 'pct',   g: 'Core', a: 'd' },
  { k: 'cpm',               f: 'CPM',                l: 'CPM',               t: 'money', g: 'Core', a: 'd' },
  { k: 'cvr',               f: 'CVR',                l: 'CVR',               t: 'pct',   g: 'Core', a: 'd' },
  { k: 'newVisits',         f: 'NEW_VISITS',         l: 'New Visits',        t: 'int',   g: 'Core', a: 's' },
  { k: 'partialVideoViews', f: 'PARTIAL_VIDEO_VIEWS',l: 'Video Views (3s)',  t: 'int',   g: 'Core', a: 's' },

  // Cost per …
  { k: 'costPerClick',            f: 'COST_PER_CLICK',             l: 'Cost / Click',        t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerLead',             f: 'COST_PER_LEAD',              l: 'Cost / Lead',         t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerNewLead',          f: 'COST_PER_NEW_LEAD',          l: 'Cost / New Lead',     t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerSale',             f: 'COST_PER_SALE',              l: 'Cost / Sale',         t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerUniqueSales',      f: 'COST_PER_UNIQUE_SALE',       l: 'Cost / Unique Sale',  t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerCall',             f: 'COST_PER_CALL',              l: 'Cost / Call',         t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerQualifiedCall',    f: 'COST_PER_QUALIFIED_CALL',    l: 'Cost / Qual. Call',   t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerUniqueCall',       f: 'COST_PER_UNIQUE_CALL',       l: 'Cost / Unique Call',  t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerNewVisit',         f: 'COST_PER_NEW_VISIT',         l: 'Cost / New Visit',    t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerUniqueCustomer',   f: 'COST_PER_UNIQUE_CUSTOMER',   l: 'Cost / Unique Cust.', t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerNewSubscriptions', f: 'COST_PER_NEW_SUBSCRIPTIONS', l: 'Cost / New Sub',      t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerNewTrials',        f: 'COST_PER_NEW_TRIALS',        l: 'Cost / New Trial',    t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerAtc',              f: 'COST_PER_ATC',               l: 'Cost / ATC',          t: 'money', g: 'Cost per', a: 'd' },
  { k: 'cac',                     f: 'CAC',                        l: 'CAC',                 t: 'money', g: 'Cost per', a: null },

  // Calls
  { k: 'calls',            f: 'CALLS',             l: 'Calls',            t: 'int', g: 'Calls', a: 's' },
  { k: 'qualifiedCalls',   f: 'QUALIFIED_CALLS',   l: 'Qualified Calls',  t: 'int', g: 'Calls', a: 's' },
  { k: 'unqualifiedCalls', f: 'UNQUALIFIED_CALLS', l: 'Unqual. Calls',    t: 'int', g: 'Calls', a: 's' },
  { k: 'uniqueCalls',      f: 'UNIQUE_CALLS',      l: 'Unique Calls',     t: 'int', g: 'Calls', a: 's' },
  { k: 'canceledCalls',    f: 'CANCELED_CALLS',    l: 'Canceled Calls',   t: 'int', g: 'Calls', a: 's' },
  { k: 'noShowCalls',      f: 'NO_SHOW_CALLS',     l: 'No-show Calls',    t: 'int', g: 'Calls', a: 's' },

  // Customers
  { k: 'customers',                    f: 'CUSTOMERS',                      l: 'Customers',           t: 'int',   g: 'Customers', a: 's' },
  { k: 'uniqueCustomers',              f: 'UNIQUE_CUSTOMERS',               l: 'Unique Customers',    t: 'int',   g: 'Customers', a: 's' },
  { k: 'totalCustomers',               f: 'TOTAL_CUSTOMERS',                l: 'Total Customers',     t: 'int',   g: 'Customers', a: 's' },
  { k: 'recurringCustomers',           f: 'RECURRING_CUSTOMERS',            l: 'Recurring Customers', t: 'int',   g: 'Customers', a: 's' },
  { k: 'returningCustomers',           f: 'RETURNING_CUSTOMERS',            l: 'Returning Customers', t: 'int',   g: 'Customers', a: 's' },
  { k: 'newCustomersOrders',           f: 'NEW_CUSTOMERS_ORDERS',           l: 'New Cust. Orders',    t: 'int',   g: 'Customers', a: 's' },
  { k: 'uniqueCustomersRevenue',       f: 'UNIQUE_CUSTOMERS_REVENUE',       l: 'Unique Cust. Revenue',t: 'money', g: 'Customers', a: 's' },
  { k: 'returningCustomersRevenue',    f: 'RETURNING_CUSTOMERS_REVENUE',    l: 'Returning Cust. Rev', t: 'money', g: 'Customers', a: 's' },
  { k: 'averageOrderValue',            f: 'AOV',                            l: 'AOV',                 t: 'money', g: 'Customers', a: 'd' },
  { k: 'newCustomersPercentage',       f: 'NEW_CUSTOMERS_PERCENTAGE',       l: 'New Cust. %',         t: 'pct',   g: 'Customers', a: null },
  { k: 'recurringCustomersPercentage', f: 'RECURRING_CUSTOMERS_PERCENTAGE', l: 'Recurring Cust. %',   t: 'pct',   g: 'Customers', a: null },
  { k: 'returningCustomersRate',       f: 'RETURNING_CUSTOMERS_RATE',       l: 'Returning Rate',      t: 'pct',   g: 'Customers', a: null },
  { k: 'returningCustomersRevenueRate',f: 'RETURNING_CUSTOMERS_REVENUE_RATE',l: 'Returning Rev Rate', t: 'pct',   g: 'Customers', a: null },
  { k: 'newCustomersRoas',             f: 'NEW_CUSTOMERS_ROAS',             l: 'New Cust. ROAS',      t: 'ratio', g: 'Customers', a: null },
  { k: 'newCustomersAov',              f: 'NEW_CUSTOMERS_AOV',              l: 'New Cust. AOV',       t: 'money', g: 'Customers', a: null },

  // Revenue detail
  { k: 'recurringRevenue',          f: 'RECURRING_REVENUE',           l: 'Recurring Revenue', t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'oneTimeSales',              f: 'ONE_TIME_SALES',              l: 'One-time Sales',    t: 'int',   g: 'Revenue detail', a: 's' },
  { k: 'refund',                    f: 'REFUND',                      l: 'Refunded $',        t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'refundCount',               f: 'REFUND_COUNT',                l: 'Refunds',           t: 'int',   g: 'Revenue detail', a: 's' },
  { k: 'refundedSalesPercentage',   f: 'REFUNDED_SALES_PERCENTAGE',   l: 'Refunded Sales %',  t: 'pct',   g: 'Revenue detail', a: 'd' },
  { k: 'refundedRevenuePercentage', f: 'REFUNDED_REVENUE_PERCENTAGE', l: 'Refunded Rev %',    t: 'pct',   g: 'Revenue detail', a: 'd' },
  { k: 'hardCosts',                 f: 'HARD_COSTS',                  l: 'Hard Costs',        t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'taxes',                     f: 'TAXES',                       l: 'Taxes',             t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'costOfGoods',               f: 'COST_OF_GOODS',               l: 'Cost of Goods',     t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'shippingValue',             f: 'SHIPPING_VALUE',              l: 'Shipping',          t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'netProfit',                 f: 'NET_PROFIT',                  l: 'Net Profit',        t: 'money', g: 'Revenue detail', a: null, tone: true },
  { k: 'netProfitPercentage',       f: 'NET_PROFIT_PERCENTAGE',       l: 'Net Profit %',      t: 'pct',   g: 'Revenue detail', a: null, tone: true },
  { k: 'grossMargins',              f: 'GROSS_MARGINS',               l: 'Gross Margin',      t: 'pct',   g: 'Revenue detail', a: null },
  { k: 'contributionProfit',        f: 'CONTRIBUTION_PROFIT',         l: 'Contribution Profit',t:'money', g: 'Revenue detail', a: null, tone: true },
  { k: 'contributionMargin',        f: 'CONTRIBUTION_MARGIN',         l: 'Contribution Margin',t:'pct',   g: 'Revenue detail', a: null },

  // Subscriptions & trials
  { k: 'newSubscriptions',      f: 'NEW_SUBSCRIPTIONS',      l: 'New Subs',       t: 'int',   g: 'Subscriptions', a: 's' },
  { k: 'canceledSubscriptions', f: 'CANCELED_SUBSCRIPTIONS', l: 'Canceled Subs',  t: 'int',   g: 'Subscriptions', a: 's' },
  { k: 'directSubscriptions',   f: 'DIRECT_SUBSCRIPTIONS',   l: 'Direct Subs',    t: 'int',   g: 'Subscriptions', a: 's' },
  { k: 'mrr',                   f: 'MRR',                    l: 'MRR',            t: 'money', g: 'Subscriptions', a: 's' },
  { k: 'newMRR',                f: 'NEW_MRR',                l: 'New MRR',        t: 'money', g: 'Subscriptions', a: 's' },
  { k: 'arr',                   f: 'ARR',                    l: 'ARR',            t: 'money', g: 'Subscriptions', a: 's' },
  { k: 'churnRate',             f: 'CHURN_RATE',             l: 'Churn Rate',     t: 'pct',   g: 'Subscriptions', a: null },
  { k: 'newTrials',             f: 'NEW_TRIALS',             l: 'New Trials',     t: 'int',   g: 'Subscriptions', a: 's' },
  { k: 'convertedTrials',       f: 'CONVERTED_TRIALS',       l: 'Converted Trials',t: 'int',  g: 'Subscriptions', a: 's' },
  { k: 'canceledTrials',        f: 'CANCELED_TRIALS',        l: 'Canceled Trials',t: 'int',   g: 'Subscriptions', a: 's' },

  // LTV & forecasts — per-customer values; never summable across sources
  { k: 'ltv30Days',   f: 'LTV_30_DAYS',   l: 'LTV 30d',  t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltv60Days',   f: 'LTV_60_DAYS',   l: 'LTV 60d',  t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltv90Days',   f: 'LTV_90_DAYS',   l: 'LTV 90d',  t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltv6Months',  f: 'LTV_6_MONTHS',  l: 'LTV 6mo',  t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltv1Year',    f: 'LTV_1_YEAR',    l: 'LTV 1yr',  t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltvForecast30Days',  f: 'LTV_30_DAYS_FORECAST',  l: 'LTV 30d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltvForecast60Days',  f: 'LTV_60_DAYS_FORECAST',  l: 'LTV 60d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltvForecast90Days',  f: 'LTV_90_DAYS_FORECAST',  l: 'LTV 90d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltvForecast6Months', f: 'LTV_6_MONTHS_FORECAST', l: 'LTV 6mo (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'ltvForecast1Year',   f: 'LTV_1_YEAR_FORECAST',   l: 'LTV 1yr (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription30DaysForecast', f: 'SUBSCRIPTION_30_DAYS_FORECAST', l: 'Sub Rev 30d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription60DaysForecast', f: 'SUBSCRIPTION_60_DAYS_FORECAST', l: 'Sub Rev 60d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription90DaysForecast', f: 'SUBSCRIPTION_90_DAYS_FORECAST', l: 'Sub Rev 90d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription6MonthsForecast', f: 'SUBSCRIPTION_6_MONTHS_FORECAST', l: 'Sub Rev 6mo (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription1YearForecast',  f: 'SUBSCRIPTION_1_YEAR_FORECAST',  l: 'Sub Rev 1yr (fcst)', t: 'money', g: 'LTV & forecasts', a: null },

  // Ecom / carts
  { k: 'carts',          f: 'CARTS',                l: 'Carts',          t: 'int', g: 'Ecom', a: 's' },
  { k: 'atcEvents',      f: 'ATC_EVENTS',           l: 'ATC Events',     t: 'int', g: 'Ecom', a: 's' },
  { k: 'purchasedCarts', f: 'PURCHASED_CARTS',      l: 'Purchased Carts',t: 'int', g: 'Ecom', a: 's' },
  { k: 'atcCvr',         f: 'CART_CONVERSION_RATE', l: 'Cart CVR',       t: 'pct', g: 'Ecom', a: 'd' },
  { k: 'atcRate',        f: 'ATC_RATE',             l: 'ATC Rate',       t: 'pct', g: 'Ecom', a: null },

  // Attribution timing
  { k: 'timeOfConversionAttributionAvg', f: 'TIME_OF_SALE_ATTRIBUTION', l: 'Days to Sale (avg)', t: 'ratio', g: 'Attribution', a: null },
  { k: 'timeOfCallAttributionAvg',       f: 'TIME_OF_CALL_ATTRIBUTION', l: 'Days to Call (avg)', t: 'ratio', g: 'Attribution', a: null },
];

export const CATALOG_BY_KEY = new Map(CATALOG.map((c) => [c.k, c]));

/** Default visible columns — the Basic-preset set the dashboard launched with. */
export const DEFAULT_KEYS = [
  'clicks', 'cost', 'totalRevenue', 'revenue', 'profit', 'reported',
  'reportedVsRevenue', 'sales', 'roi', 'roas', 'calls', 'leads',
  'costPerLead', 'impressions', 'ctr', 'cpm',
];

/** Metrics that are safe to sum when rolling child rows into a parent. */
export const ADDITIVE = CATALOG.filter((c) => c.a === 's').map((c) => c.k);

const ratio = (a, b) => (num(b) === 0 ? null : num(a) / num(b));
const pct100 = (a, b) => (num(b) === 0 ? null : (num(a) / num(b)) * 100);

/**
 * Extended derived metrics: computed only when the API did not supply a value
 * (rolled-up rows), so native ad-set/ad rows keep HYROS's own numbers.
 */
const RATIOS = {
  costPerClick:            (r) => ratio(r.cost, r.clicks),
  costPerLead:             (r) => ratio(r.cost, r.leads),
  costPerNewLead:          (r) => ratio(r.cost, r.newLeads),
  costPerSale:             (r) => ratio(r.cost, r.sales),
  costPerUniqueSales:      (r) => ratio(r.cost, r.uniqueSales),
  costPerCall:             (r) => ratio(r.cost, r.calls),
  costPerQualifiedCall:    (r) => ratio(r.cost, r.qualifiedCalls),
  costPerUniqueCall:       (r) => ratio(r.cost, r.uniqueCalls),
  costPerNewVisit:         (r) => ratio(r.cost, r.newVisits),
  costPerUniqueCustomer:   (r) => ratio(r.cost, r.uniqueCustomers),
  costPerNewSubscriptions: (r) => ratio(r.cost, r.newSubscriptions),
  costPerNewTrials:        (r) => ratio(r.cost, r.newTrials),
  costPerAtc:              (r) => ratio(r.cost, r.atcEvents),
  averageOrderValue:       (r) => ratio(r.revenue, r.sales),
  cvr:                     (r) => pct100(r.sales, r.clicks),
  refundedSalesPercentage: (r) => pct100(r.refundCount, r.sales),
  refundedRevenuePercentage:(r) => pct100(r.refund, r.revenue),
  atcCvr:                  (r) => pct100(r.purchasedCarts, r.carts),
};

/**
 * Recompute every derived metric from the additive base.
 * Never average a derived metric across children — always re-derive.
 * The verified core set is always recomputed; extended ratios only fill
 * gaps so native API values are preserved.
 */
export function derive(row) {
  const cost = num(row.cost);
  const revenue = num(row.revenue);
  // HYROS ROAS counts rebills: revenue is one-time sales only, totalRevenue adds
  // recurring, so total >= revenue; a missing or zeroed total falls back to revenue.
  const totalRevenue = Math.max(revenue, num(row.totalRevenue));
  const impressions = num(row.impressions);

  const out = {
    ...row,
    profit: revenue - cost,
    roas: cost === 0 ? null : totalRevenue / cost,
    roi: cost === 0 ? null : ((revenue - cost) / cost) * 100,
    reportedVsRevenue: revenue - num(row.reported),
    ctr: impressions === 0 ? null : (num(row.clicks) / impressions) * 100,
    cpm: impressions === 0 ? null : (cost / impressions) * 1000,
    cpl: ratio(cost, row.leads),
    cps: ratio(cost, row.sales),
    cpc: ratio(cost, row.clicks),
  };

  for (const [key, fn] of Object.entries(RATIOS)) {
    if (out[key] === null || out[key] === undefined) {
      const v = fn(out);
      if (v !== null) out[key] = v;
    }
  }
  return out;
}

/** Sum a set of rows into one row, then re-derive. */
export function aggregate(rows, seed = {}) {
  const base = { ...seed };
  for (const key of ADDITIVE) base[key] = 0;
  for (const row of rows) {
    for (const key of ADDITIVE) base[key] += num(row[key]);
  }
  return derive(base);
}

/**
 * Group rows by a key and roll each group up.
 * `keyOf` returns null to drop a row from this level.
 */
export function rollup(rows, keyOf, labelOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([id, group]) =>
    aggregate(group, { id, name: labelOf(id, group), children: group.length }),
  );
}

/* ------------------------------------------------------------------ *
 * Formatting — shared so the table and the CSV export never disagree.
 * ------------------------------------------------------------------ */

export const fmt = {
  /* Presentation switch: demo mode shows whole dollars (cents are noise on
     a projector); live/seed data keeps the cents the HYROS UI shows. */
  cents: true,
  /* The account's currency (ISO 4217, from snapshot.account.currency). HYROS
     reports every amount in the account currency, so a EUR account must read
     €357.04, not $357.04. app.js sets it whenever a snapshot is applied. */
  currency: 'USD',
  /* ISO 4217 codes are three letters. Anything else from the API (or a
     malformed value) falls back to USD so no untrusted string ever reaches
     the DOM through a money cell. */
  currencyCode(code) {
    const c = String(code ?? '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : 'USD';
  },
  money(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const sign = v < 0 ? '-' : '';
    const digits = fmt.cents ? 2 : 0;
    const abs = Math.abs(v);
    try {
      return sign + new Intl.NumberFormat('en-US', {
        style: 'currency', currency: fmt.currencyCode(fmt.currency), currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(abs);
    } catch {
      // Unknown code: prefix it instead of guessing a symbol.
      return `${sign}${fmt.currencyCode(fmt.currency)} ${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
    }
  },
  /* A record that carries its own currency (a sale in another store currency). Falls back to the account currency. */
  moneyIn(v, code) {
    const safe = fmt.currencyCode(code);
    if (!code || safe === fmt.currency) return fmt.money(v);
    const was = fmt.currency; fmt.currency = safe;
    try { return fmt.money(v); } finally { fmt.currency = was; }
  },
  /* Whole units in the account currency (axis ticks, compact labels). */
  money0(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const was = fmt.cents; fmt.cents = false;
    try { return fmt.money(v); } finally { fmt.cents = was; }
  },
  int(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return Math.round(v).toLocaleString('en-US');
  },
  pct(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return `${v.toFixed(2)}%`;
  },
  ratio(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return v.toFixed(2);
  },
  date(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },
  datetime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  },
};

export function formatCell(value, type) {
  switch (type) {
    case 'money': return fmt.money(value);
    case 'int':   return fmt.int(value);
    case 'pct':   return fmt.pct(value);
    case 'ratio': return fmt.ratio(value);
    default:      return value == null || value === '' ? '—' : String(value);
  }
}
