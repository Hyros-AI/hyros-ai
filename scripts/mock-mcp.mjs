/**
 * Mock HYROS MCP — a stateless JSON-RPC server that answers the tools the
 * snapshot pipeline calls with synthetic payloads in the shapes the real MCP
 * returns (Sept 2026 surface: parentId on ad rows, updatedFromDate on leads,
 * marginal CAC curves, domain script checks, tracking-parameter checks).
 *
 *   node scripts/mock-mcp.mjs            # listens on :4322
 *   HYROS_MCP_URL=http://127.0.0.1:4322/mcp HYROS_API_KEY=mock node scripts/pipeline-test.mjs
 *
 * Every request is logged (tool name + the request fields the pipeline
 * sends) so a test can assert WHAT the pipeline asked for, not just what it
 * rendered.
 *
 * The exported `mock` control object lets a test bend the server the way the
 * real one misbehaves (api-docs.hyros.com): HTTP 429 with `Retry-After`,
 * HTTP 403 for a missing role, multi-page results, an expired cursor on
 * page 2, latency, a different ad-account list, a different user timezone.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_MCP_PORT) || 4322;
export const calls = [];

/** A tool-level failure: the dispatcher turns it into an isError reply, like the real MCP. */
class ToolError extends Error {}

/** The live MCP wants every tool's arguments under `request`; flat arguments are rejected. */
const journeyEmails = (request, flat) => {
  if (!request && flat) throw new ToolError('hyros_get_lead_journey: Missing required property: request');
  return request?.emails || [];
};

/**
 * Test controls. Everything resets with `mock.reset()`.
 *   mock.failNext({ tool, status, body, retryAfter, times })  HTTP-level failure(s) for the next call(s)
 *   mock.pages(tool, n, size)     serve n pages of `size` rows with nextPageId
 *   mock.expireCursorOn(tool)     tool error "pageId ... expired" as soon as a pageId is sent
 *   mock.latencyMs = 4000         delay every tool call (number) or per tool ({ tool: ms })
 *   mock.adAccounts = []          replace the ad-account list
 *   mock.timezone = 'America/New_York'   userProfile.timezone
 *   mock.now = Date.parse('2026-09-14T12:00:00Z')   the mock's clock for the
 *       report's "cannot be in the future" check (null = the real clock);
 *       kept across reset() so a test sets it once next to its build `now`
 */
export const mock = {
  failures: [],
  paged: {},
  expiredCursors: new Set(),
  latencyMs: 0,
  adAccounts: null,
  timezone: null,
  now: null,
  failNext(spec) { this.failures.push({ times: 1, ...spec }); },
  pages(tool, n, size = 250) { this.paged[tool] = { n, size }; },
  expireCursorOn(tool) { this.expiredCursors.add(tool); },
  reset() {
    this.failures = []; this.paged = {}; this.expiredCursors = new Set();
    this.latencyMs = 0; this.adAccounts = null; this.timezone = null;
  },
};

// Ad accounts of every type the real MCP reports, plus one that is connected
// but broken (9007) so the pipeline's per-account isolation is exercised.
const AD_ACCOUNTS = [
  { id: '9001', name: 'Mock Meta', type: 'FACEBOOK' },
  { id: '9002', name: 'Mock Google', type: 'GOOGLE' },
  { id: '9003', name: 'Mock Snap', type: 'SNAPCHAT' },
  { id: '9004', name: 'Mock LinkedIn', type: 'LINKEDIN' },
  { id: '9005', name: 'Mock Google V2', type: 'GOOGLE_V2' },
  { id: '9006', name: 'Mock Reddit', type: 'REDDIT' },
  { id: '9007', name: 'Mock TikTok (broken)', type: 'TIKTOK' },
];
const adAccounts = () => mock.adAccounts ?? AD_ACCOUNTS;

// The `level` enum of GET /attribution (api-docs.hyros.com), per integration.
// The real MCP rejects any other combination with the message mirrored below.
const LEVELS_FOR = {
  FACEBOOK: ['facebook_campaign', 'facebook_adset', 'facebook_ad'],
  GOOGLE: ['google_campaign', 'google_ad'],
  GOOGLE_V2: ['google_v2_adgroup', 'google_v2_keyword'],
  TIKTOK: ['tiktok_adgroup', 'tiktok_ad'],
  SNAPCHAT: ['snapchat_adset', 'snapchat_ad'], // the live MCP's name (REST docs say adsquad)
  PINTEREST: ['pinterest_adgroup', 'pinterest_ad'],
  TWITTER: ['twitter_adgroup'],
  BING: ['bing_adgroup', 'bing_ad'],
  LINKEDIN: ['linkedin_campaign'],
  REDDIT: [],
};

const ADSETS = [
  { id: 'as-1', name: 'Prospecting Broad', tag: '@as-1', category: 'Prospecting', cost: 900, revenue: 3200, sales: 24, leads: 80, clicks: 1200 },
  { id: 'as-2', name: 'Powerset', tag: '@as-2', category: 'Retargeting', cost: 300, revenue: 1800, sales: 15, leads: 30, clicks: 400 },
  { id: 'as-3', name: 'Powerset', tag: '@as-3', category: 'Prospecting', cost: 250, revenue: 500, sales: 4, leads: 22, clicks: 350 },
];
const ADS = [
  { id: 'ad-1', name: 'UGC Hook', parentId: 'as-1', parentName: 'Prospecting Broad', cost: 600, revenue: 2400, sales: 18, leads: 55, clicks: 800 },
  { id: 'ad-2', name: 'Static Offer', parentId: 'as-1', parentName: 'Prospecting Broad', cost: 300, revenue: 800, sales: 6, leads: 25, clicks: 400 },
  { id: 'ad-3', name: 'Carousel', parentId: 'as-2', parentName: 'Powerset', cost: 300, revenue: 1800, sales: 15, leads: 30, clicks: 400 },
  { id: 'ad-4', name: 'Founder Story', parentId: 'as-3', parentName: 'Powerset', cost: 250, revenue: 500, sales: 4, leads: 22, clicks: 350 },
];

const lead = (i, joined, updated, stage = 'Lead') => ({
  id: `lead-${i}`, email: `lead${i}@example.test`, firstName: `Lead`, lastName: String(i),
  creationDate: joined, lastUpdatedDate: updated, tags: ['!site', '@as-1'],
  currentStage: { name: stage, date: updated }, adOptimizationConsent: 'GRANTED',
  firstSource: { name: 'Prospecting Broad', tag: '@as-1', organic: false, clickDate: joined },
  lastSource: { name: 'Prospecting Broad', tag: '@as-1', organic: false, clickDate: joined },
  phoneNumbers: [],
});

// Sales as GET /sales documents them: `creationDate` in the legacy
// `EEE MMM dd HH:mm:ss zzz yyyy` format and a `price` object. `usdPrice` is
// undocumented but the live MCP sends it; s1 keeps it so both paths are tested.
const SALES = [
  { id: 's1', lead: { email: 'lead1@example.test', firstName: 'Lead', lastName: '1' }, creationDate: '2026-09-05T12:00:00-05:00', usdPrice: { price: 160, currency: 'USD' }, price: { price: 149, currency: 'USD' }, product: { name: 'Bundle' }, firstSource: { name: 'Prospecting Broad' }, lastSource: { name: 'Prospecting Broad' } },
  { id: 's2', lead: { email: 'lead2@example.test', firstName: 'Lead', lastName: '2' }, creationDate: 'Thu Jul 02 01:10:33 ART 2026', price: { price: 89, currency: 'EUR' }, product: { name: 'Starter' }, firstSource: { name: 'Powerset' }, lastSource: { name: 'Powerset' } },
];

const CLIENTS = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ accountId: `c${i}`, email: `client${i}@example.test`, companyName: `Client ${i}`, firstName: 'C', lastName: String(i), status: i === 7 ? 'PENDING' : 'APPROVED' }));

const TOOLS = {
  // `_key` / `_client` are the request context the mock server passes in.
  hyros_get_user_info: (args, { key, client }) => (client
    ? { userProfile: { email: `client${client.slice(1)}@example.test`, timezone: mock.timezone || '-05:00' }, trueTrackingData: {}, allowedAccounts: [], accessibleAccounts: [] }
    : {
      userProfile: { email: key === 'agency-key' ? 'agency@example.test' : 'mock@hyros.test', timezone: mock.timezone || '-05:00' },
      trueTrackingData: { OUTBOUND_CURRENCY: 'USD', LEAD_ATTRIBUTION_TIMEFRAME: '7' },
      allowedAccounts: key === 'agency-key' ? [] : [{ accountId: 'agency-9', email: 'agency@example.test', companyName: 'Agency', status: 'APPROVED' }],
      accessibleAccounts: key === 'agency-key' ? CLIENTS : [],
    }),
  hyros_get_ad_accounts: () => ({ result: adAccounts(), nextPageId: null }),
  hyros_get_sources: () => ({
    result: [
      ...ADSETS.map((a) => ({
        name: a.name, tag: a.tag, category: { name: a.category }, trafficSource: { name: 'facebook' },
        adSource: { adSourceId: a.id, adAccountId: '9001', platform: 'FACEBOOK' },
      })),
      // The real source list covers every connected platform, one per source link.
      ...adAccounts().filter((acct) => acct.id !== '9001').map((acct) => ({
        name: `${acct.name} row`, tag: `@${acct.id}-1`, category: { name: 'Prospecting' }, trafficSource: { name: acct.type.toLowerCase() },
        adSource: { adSourceId: `${acct.id}-1`, adAccountId: acct.id, platform: acct.type },
      })),
    ],
    nextPageId: null,
  }),
  hyros_get_attribution_report: ({ request }) => {
    // The live report rejects any bound after the current time (observed 2026-09-17).
    const clock = mock.now ?? Date.now();
    for (const bound of [request.startDate, request.endDate]) {
      const t = Date.parse(/[+-]\d\d:\d\d$|Z$/.test(bound || '') ? bound : `${bound}Z`);
      if (Number.isFinite(t) && t > clock) throw new ToolError('hyros_get_attribution_report: startDate or endDate cannot be in the future.');
    }
    const acct = adAccounts().find((a) => a.id === String(request.ids[0]));
    if (!acct) return { result: [], nextPageId: null };
    const level = String(request.level || '').toLowerCase();
    if (!(LEVELS_FOR[acct.type] || []).includes(level)) {
      throw new ToolError(`Unsupported level type ${level} for user integration: ${acct.type}. Product ID: 1`);
    }
    if (acct.id === '9007') throw new ToolError('Ad account integration is disconnected');
    if (acct.id !== '9001') {
      // One row per non-Meta account so the pipeline can be seen to carry it.
      const row = { id: `${acct.id}-1`, name: `${acct.name} row`, cost: 100, revenue: 300, sales: 2, leads: 5, clicks: 50 };
      return { result: [/_ad$/.test(level) ? { ...row, id: `${acct.id}-ad-1`, parentId: row.id, parentName: row.name } : row], nextPageId: null };
    }
    const rows = /_ad$/.test(level) ? ADS : ADSETS;
    return { result: rows.map((r) => ({ ...r, impressions: r.clicks * 40, totalRevenue: r.revenue, reportedResult: r.revenue * 0.7 })), nextPageId: null };
  },
  hyros_get_stages: () => ({ result: [{ name: 'Lead', amount: 120 }, { name: 'Customer', amount: 40 }], nextPageId: null }),
  hyros_get_leads: ({ request }) => {
    if (request.updatedFromDate) {
      // Incremental pull: one changed lead (stage moved), one brand-new lead,
      // and one that was merged into lead-1 (the API marks it with originLead).
      return { result: [
        lead(1, '2026-09-02T10:00:00-05:00', '2026-09-13T09:00:00-05:00', 'Customer'),
        lead(9, '2026-09-13T08:00:00-05:00', '2026-09-13T08:00:00-05:00'),
        { ...lead(2, '2026-09-02T10:00:00-05:00', '2026-09-13T09:30:00-05:00'), originLead: { id: 'lead-1', email: 'lead1@example.test', isOriginLead: true } },
      ], nextPageId: null };
    }
    if (request.tags) return { result: [lead(1, '2026-09-02T10:00:00-05:00', '2026-09-02T10:00:00-05:00')], nextPageId: null };
    return { result: [1, 2, 3].map((i) => lead(i, `2026-09-0${i}T10:00:00-05:00`, `2026-09-0${i}T10:00:00-05:00`)), nextPageId: null };
  },
  hyros_get_sales: ({ request }) => {
    // Incremental pull: s1 was refunded since, s3 is a new sale (lead-9).
    if (request?.updatedFromDate) return { result: [
      { ...SALES[0], refundDate: '2026-09-13T09:00:00-05:00' },
      { id: 's3', lead: { email: 'lead9@example.test', firstName: 'Lead', lastName: '9' }, creationDate: '2026-09-13T08:30:00-05:00', price: { price: 50, currency: 'USD' }, product: { name: 'Starter' }, firstSource: { name: 'Powerset' }, lastSource: { name: 'Powerset' } },
    ], nextPageId: null };
    return { result: SALES, nextPageId: null };
  },
  hyros_get_calls: ({ request }) => (request?.updatedFromDate
    ? { result: [{ id: 'call-9', lead: { email: 'lead9@example.test', firstName: 'Lead', lastName: '9' }, creationDate: '2026-09-13T11:00:00-05:00', state: 'QUALIFIED', qualified: true }], nextPageId: null }
    : { result: [], nextPageId: null }),
  hyros_get_subscriptions: () => ({ result: [], nextPageId: null }),
  hyros_get_lead_journey: ({ request, emails }) => journeyEmails(request, emails).map((email) => ({
    lead: lead(1, '2026-09-02T10:00:00-05:00', '2026-09-02T10:00:00-05:00'),
    sales: SALES.filter((s) => s.lead.email === email), calls: [], journey: [{ type: 'click', date: '2026-09-02T10:00:00-05:00', name: 'Prospecting Broad' }],
  })),
  hyros_get_lead_clicks: ({ request }) => {
    if (request.email && !request.emails) throw new ToolError('email is deprecated: use emails');
    return { result: [{ date: 'Thu Sep 02 10:00:00 EST 2026', page: 'https://mock.example.test/', sourceLinkName: 'Prospecting Broad', adspendType: 'FACEBOOK' }], nextPageId: null };
  },
  // Documented shape (rest-api.txt /attribution/marginal-cac-curve): spend levels
  // in ascending order, marginalCac null on the first bucket, saturationPoint as
  // efficient/saturated levels. Account level has no LTV: ceiling = caller's or none.
  hyros_get_marginal_cac_curve: ({ request }) => {
    const account = String(request.level).toUpperCase() === 'ACCOUNT';
    const caller = request.cacCeiling !== undefined && request.cacCeiling !== null;
    const cacCeiling = caller ? Number(request.cacCeiling) : (account ? null : 95);
    const levels = [20, 45, 70, 95, 120];
    return {
      id: request.id, level: request.level, name: account ? null : `Mock ${request.level} ${request.id}`,
      startDate: request.startDate, endDate: request.endDate,
      attributionModel: 'FIRST_CLICK', daysSampled: 42, cacCeiling,
      ceilingBasis: caller ? 'CALLER_PROVIDED' : (account ? null : 'LTV_BREAKEVEN'),
      ltvWindow: !caller && !account ? '90_days' : null,
      curve: levels.map((spend, i) => ({ spendPerDay: spend, days: 8, newCustomers: Math.round((spend * 8) / (40 + spend * 0.3)), avgCac: 40 + spend * 0.3, marginalCac: i ? 40 + spend * 0.8 : null })),
      saturationPoint: cacCeiling === null ? null : { efficientSpendPerDay: 45, saturatedSpendPerDay: 70, reason: 'MARGINAL_CAC_ABOVE_CEILING' },
      notes: cacCeiling === null ? ['LTV_CEILING_UNAVAILABLE'] : [],
    };
  },
  // Tracking Health. The script check is the slow one on the real MCP (it
  // fetches every domain live); simulate that with the per-tool latency hook,
  // e.g. `mock.latencyMs = { hyros_assert_script_presence_on_domain: 20000 }`,
  // to see the health step time it out and record checks.script.failed.
  hyros_get_domains: () => ['mock.example.test', 'shop.mock.example.test'],
  hyros_assert_script_presence_on_domain: ({ request, domains }) => {
    // The live MCP rejects flat arguments: every tool wants them under `request`.
    if (!request && domains) throw new ToolError('hyros_assert_script_presence_on_domain: Missing required property: request');
    return Object.fromEntries((request?.domains || []).map((d, i) => [d, i ? 'SCRIPT_NOT_FOUND' : 'SCRIPT_FOUND']));
  },
  hyros_check_tracking_parameters_for_integrations: ({ request = {} }) => ({ result: [{ adName: `${request.type} ad 1`, valid: true }, { adName: `${request.type} ad 2`, valid: false, missing: ['gclid'] }] }),
};

/**
 * Pagination the way the documented list endpoints do it: `pageId` from the
 * previous `nextPageId`, null on the last page, an error for a cursor the
 * server no longer knows. Rows are the tool's first row cloned with unique ids.
 */
function paginate(name, args, body) {
  const spec = mock.paged[name];
  const pageId = args?.request?.pageId;
  if (pageId && mock.expiredCursors.has(name)) throw new ToolError('pageId is invalid or has expired');
  if (!spec || !Array.isArray(body?.result)) return body;
  const page = pageId ? Number(String(pageId).split(':')[1]) : 0;
  const base = body.result[0] || {};
  const rows = Array.from({ length: spec.size }, (_, i) => {
    const n = page * spec.size + i;
    return { ...base, id: `${base.id || name}-${n}`, ...(base.email ? { email: `p${n}-${base.email}` } : {}) };
  });
  return { result: rows, nextPageId: page + 1 < spec.n ? `${name}:${page + 1}` : null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const latencyFor = (name) => (typeof mock.latencyMs === 'number' ? mock.latencyMs : (mock.latencyMs?.[name] || 0));

/** An injected HTTP-level failure for this call, consumed from the queue. */
function takeFailure(name) {
  const i = mock.failures.findIndex((f) => !f.tool || f.tool === name);
  if (i < 0) return null;
  const f = mock.failures[i];
  if (f.times <= 1) mock.failures.splice(i, 1); else f.times -= 1;
  return f;
}

export function startMock(port = PORT) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body || '{}');
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); };
    if (rpc.method === 'tools/list') return reply({ tools: Object.keys(TOOLS).map((name) => ({ name })) });
    const key = req.headers['api-key'] || null;
    if (key === 'dead-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"invalid api key"}'); }
    if (rpc.method === 'tools/call') {
      const { name, arguments: args = {} } = rpc.params || {};
      // The real MCP documents accessible_account_id "on other tools"; the mock honors the ARGUMENT form only.
      const client = args.accessible_account_id || null;
      calls.push({ name, args, apiKey: key, client, headerClient: req.headers['accessible-account-id'] || null });
      const failure = takeFailure(name);
      if (failure) {
        const headers = { 'content-type': 'application/json', ...(failure.retryAfter != null ? { 'retry-after': String(failure.retryAfter) } : {}) };
        res.writeHead(failure.status || 500, headers);
        return res.end(typeof failure.body === 'string' ? failure.body : JSON.stringify(failure.body ?? { error: `injected HTTP ${failure.status}` }));
      }
      const latency = latencyFor(name);
      if (latency) await sleep(latency);
      const fn = TOOLS[name];
      if (!fn) return reply({ isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] });
      try {
        return reply({ content: [{ type: 'text', text: JSON.stringify(paginate(name, args, fn(args, { key, client }))) }] });
      } catch (err) {
        if (err instanceof ToolError) return reply({ isError: true, content: [{ type: 'text', text: err.message }] });
        throw err;
      }
    }
    reply({});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock().then(() => console.log(`mock MCP on http://127.0.0.1:${PORT}/mcp`));
}
