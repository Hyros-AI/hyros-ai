/**
 * Credential resolution for the snapshot store.
 *
 * Vercel names the Redis REST variables differently depending on how the
 * database was provisioned, and forces a custom prefix when a name is already
 * taken. These cases cover every shape we can be handed.
 */
const mod = new URL('../api/_store.js', import.meta.url);
let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
  if (!ok) fails++;
};

async function withEnv(vars, fn) {
  for (const k of Object.keys(process.env)) {
    if (k.includes('REST_API') || k.includes('UPSTASH')) delete process.env[k];
  }
  Object.assign(process.env, vars);
  // bust the module cache so top-level state re-evaluates
  const m = await import(`${mod.href}?t=${Math.random()}`);
  return fn(m);
}

console.log('\nCredential resolution');

await withEnv({ KV_REST_API_URL: 'u1', KV_REST_API_TOKEN: 't1' },
  (m) => check('canonical KV pair', m.storeCredentials()?.via, 'KV_REST_API_URL'));

await withEnv({ UPSTASH_REDIS_REST_URL: 'u2', UPSTASH_REDIS_REST_TOKEN: 't2' },
  (m) => check('marketplace Upstash pair', m.storeCredentials()?.via, 'UPSTASH_REDIS_REST_URL'));

await withEnv({ STORAGE_REST_API_URL: 'u3', STORAGE_REST_API_TOKEN: 't3' },
  (m) => check('custom prefix (STORAGE_)', m.storeCredentials()?.via, 'STORAGE_REST_API_URL'));

await withEnv({ KV_REST_API_URL: 'u4', KV_REST_API_READ_ONLY_TOKEN: 'ro' },
  (m) => check('read-only token is NOT accepted', m.storeCredentials(), null));

await withEnv({ KV_REST_API_URL: '' , KV_REST_API_TOKEN: '' },
  (m) => check('empty placeholders ignored', m.storeCredentials(), null));

await withEnv({}, (m) => check('nothing configured', m.storeCredentials(), null));

await withEnv({ KV_REST_API_URL: 'u5', KV_REST_API_TOKEN: 't5', STORAGE_REST_API_URL: 'x', STORAGE_REST_API_TOKEN: 'y' },
  (m) => check('canonical wins over prefixed', m.storeCredentials()?.via, 'KV_REST_API_URL'));

/* ------------------------------------------------------------------ *
 * API route contracts (setup / health / data) — pure helpers and handlers
 * driven with fake req/res objects. No store, no MCP needed unless noted.
 * ------------------------------------------------------------------ */
console.log('\nAPI route contracts');
const ok = (name, cond, extra = '') => check(name, Boolean(cond), true) || (cond ? null : console.log(`        ${extra}`));

{
  const { errorBody } = await import('../api/setup.js');
  const mcp = (code, message = 'boom') => Object.assign(new Error(message), { name: 'McpError', code });
  const auth = errorBody(mcp('auth', 'MCP rejected the API key (HTTP 401)'));
  ok('setup error: auth keeps error=bad_key and carries code=auth', auth.ok === false && auth.error === 'bad_key' && auth.code === 'auth', JSON.stringify(auth));
  ok('setup error: auth message tells the user to re-copy the key', /Settings → API/.test(auth.message), auth.message);
  const forb = errorBody(mcp('forbidden', 'Missing role'));
  ok('setup error: forbidden is not "bad key" — points at HYROS support', forb.code === 'forbidden' && /HYROS support/.test(forb.message) && !/rejected that key/.test(forb.message), JSON.stringify(forb));
  const rl = errorBody(mcp('rate_limited', 'request limit'));
  ok('setup error: rate_limited says wait and retry', rl.code === 'rate_limited' && /wait/.test(rl.message), JSON.stringify(rl));
  const nc = errorBody(Object.assign(new Error('No HYROS API key is available for this account'), { name: 'McpNotConfigured', code: 'NOT_CONFIGURED' }));
  ok('setup error: NOT_CONFIGURED travels as its own code', nc.code === 'NOT_CONFIGURED' && nc.error === 'NOT_CONFIGURED', JSON.stringify(nc));
  const raw = errorBody(mcp(undefined, 'hyros_get_user_info: MCP is not enabled for this account'));
  ok('setup error: an MCP error without a code keeps the server text as detail', raw.error === 'bad_key' && raw.detail === 'hyros_get_user_info: MCP is not enabled for this account', JSON.stringify(raw));
  const weak = errorBody(Object.assign(new Error('Use at least 8 characters.'), { status: 400, code: 'weak' }));
  ok('setup error: plain coded errors pass through unchanged', weak.error === 'weak' && weak.code === 'weak' && weak.message === 'Use at least 8 characters.', JSON.stringify(weak));
}

/* Handlers end to end: an in-memory KV (same stub the pipeline test uses) and the mock MCP. */
{
  const mem = new Map();
  globalThis.fetch = ((orig) => async (url, opts) => {
    if (String(url).startsWith('http://kv.local')) {
      const [cmd, k, v, ...rest] = JSON.parse(opts.body);
      if (cmd === 'GET') return new Response(JSON.stringify({ result: mem.get(k) ?? null }));
      if (cmd === 'SET') { mem.set(k, v); return new Response(JSON.stringify({ result: 'OK' })); }
      if (cmd === 'DEL') { let n = 0; for (const key of [k, v, ...rest].filter(Boolean)) n += mem.delete(key) ? 1 : 0; return new Response(JSON.stringify({ result: n })); }
      if (cmd === 'SCAN') { const prefix = String(rest[0] || '').replace(/\*$/, ''); return new Response(JSON.stringify({ result: ['0', [...mem.keys()].filter((key) => key.startsWith(prefix))] })); }
    }
    return orig(url, opts);
  })(globalThis.fetch);
  const PORT = 4323;
  process.env.KV_REST_API_URL = 'http://kv.local'; process.env.KV_REST_API_TOKEN = 't';
  process.env.HYROS_MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
  process.env.ACCOUNT_KEY_SECRET = 'test-secret';
  delete process.env.REPORT_PASSWORD; delete process.env.HYROS_API_KEY;
  const { startMock } = await import('./mock-mcp.mjs');
  const server = await startMock(PORT);
  const fakeRes = () => ({ code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const req = (url, headers = {}, method = 'GET', body = undefined) => ({ url, method, headers: { host: 'x', ...headers }, body });
  const PW = 'correct-horse-battery';
  try {
    const { TEMPLATE_VERSION } = await import('../api/_version.js');
    const setupMod = await import('../api/_setup.js');
    await setupMod.setPassword(PW);
    const acc = await import('../api/_accounts.js');
    const added = await acc.addAccount('client-key-XYZ');

    const health = await import('../api/health.js');
    ok('health: REQUIRED_TOOLS lists the 15 tools the app needs', Array.isArray(health.REQUIRED_TOOLS) && health.REQUIRED_TOOLS.length === 15 && health.REQUIRED_TOOLS.includes('hyros_get_marginal_cac_curve'));
    ok('health: missingTools() returns what the list lacks', JSON.stringify(health.missingTools(['hyros_get_user_info', 'hyros_get_leads'])) === JSON.stringify(health.REQUIRED_TOOLS.filter((t) => !['hyros_get_user_info', 'hyros_get_leads'].includes(t))));
    ok('health: missingTools() is empty for a complete list', health.missingTools(health.REQUIRED_TOOLS).length === 0);
    let res = fakeRes();
    await health.default(req('/api/health', { 'x-report-key': PW }), res);
    ok('health: answers with templateVersion', res.body?.templateVersion === TEMPLATE_VERSION, JSON.stringify(res.body));
    ok('health: missingTools is empty now that the mock exposes every required tool', Array.isArray(res.body?.missingTools) && res.body.missingTools.length === 0, JSON.stringify(res.body?.missingTools));
    ok('health: still reports toolCount and the account email', res.body?.toolCount > 0 && res.body?.accountEmail === 'mock@hyros.test' && res.body?.account === added.account.id, JSON.stringify(res.body));

    const data = await import('../api/data.js');
    res = fakeRes();
    await data.default(req('/api/data', { 'x-report-key': PW }), res);
    ok('data: answers with templateVersion', res.body?.ok === true && res.body?.templateVersion === TEMPLATE_VERSION, JSON.stringify(res.body));

    const setupRoute = await import('../api/setup.js');
    res = fakeRes();
    await setupRoute.default(req('/api/setup'), res);
    ok('setup GET (unauthenticated): only ok, state, storage, pendingSecrets', Object.keys(res.body || {}).sort().join(',') === 'ok,pendingSecrets,state,storage' && res.body.state === 'ready' && res.body.storage === true && res.body.pendingSecrets === true, JSON.stringify(res.body));
    res = fakeRes();
    await setupRoute.default(req('/api/setup', { 'x-report-key': PW }), res);
    ok('setup GET (authenticated): the full object with accounts, storeVia, secret sources, templateVersion', res.body?.accounts === 1 && res.body?.storeVia === 'KV_REST_API_URL' && res.body?.keySecret === 'env' && res.body?.cronSecret === 'kv' && res.body?.templateVersion === TEMPLATE_VERSION && res.body?.mcpUrl, JSON.stringify(res.body));
    res = fakeRes();
    await setupRoute.default(req('/api/setup?secrets=1'), res);
    ok('setup GET ?secrets=1 without the password is refused', res.code === 401 && res.body?.error === 'unauthorized', JSON.stringify(res.body));
    res = fakeRes();
    await setupRoute.default(req('/api/setup?secrets=1', { 'x-report-key': PW }), res);
    ok('setup GET ?secrets=1 with the password returns the pending CRON_SECRET', /^[0-9a-f]{64}$/.test(res.body?.secrets?.CRON_SECRET || ''), JSON.stringify(res.body?.secrets));
  } finally {
    server.close();
  }
}

/* Vercel preview deployments share the production store when Upstash is connected to
 * "all environments": every write (refresh, setup, reset, cron lock) must be refused there. */
console.log('\nPreview deployments are read-only');
{
  const mem = new Map([['aihyros:acct:x:snapshot', JSON.stringify({ generatedAt: '2026-09-23T00:00:00.000Z', origin: 'mcp' })]]);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('http://kv.ro')) return orig(url, opts);
    const [cmd, k, v, ...rest] = JSON.parse(opts.body);
    if (cmd === 'GET') return new Response(JSON.stringify({ result: mem.get(k) ?? null }));
    if (cmd === 'SET') { mem.set(k, v); return new Response(JSON.stringify({ result: 'OK' })); }
    if (cmd === 'DEL') { let n = 0; for (const key of [k, v, ...rest].filter(Boolean)) n += mem.delete(key) ? 1 : 0; return new Response(JSON.stringify({ result: n })); }
    if (cmd === 'SCAN') return new Response(JSON.stringify({ result: ['0', [...mem.keys()]] }));
    return new Response(JSON.stringify({ result: null }));
  };
  const env = { KV_REST_API_URL: 'http://kv.ro', KV_REST_API_TOKEN: 't' };
  delete process.env.VERCEL_ENV;
  await withEnv(env, (m) => check('storeReadOnly() is null outside previews', m.storeReadOnly?.() ?? null, null));
  process.env.VERCEL_ENV = 'preview';
  await withEnv(env, async (m) => {
    check('storeReadOnly() names the preview environment', m.storeReadOnly?.() ?? null, 'preview');
    const wrote = await m.writeSnapshot({ generatedAt: '2026-09-24T00:00:00.000Z', origin: 'mcp' }, 'x');
    check('writeSnapshot on a preview answers false', wrote, false);
    check('…and the production snapshot is untouched', JSON.parse(mem.get('aihyros:acct:x:snapshot')).generatedAt, '2026-09-23T00:00:00.000Z');
    check('…and no dated history copy is written', [...mem.keys()].some((k) => k.endsWith(':2026-09-24')), false);
    const read = await m.readSnapshot('x');
    check('readSnapshot still works on a preview', read?.origin, 'mcp');
    const wiped = await m.wipeAll();
    check('wipeAll on a preview deletes nothing', wiped, 0);
    check('…and the store still has its keys', mem.size, 1);
    check('kvRaw refuses a SET (the cron lock) on a preview', await m.kvRaw(['SET', 'aihyros:cron:lock', 'now', 'NX', 'EX', '10']), null);
    const setup = await import('../api/_setup.js');
    const st = await setup.setupState();
    check('setupState() reports readOnly = preview', st.readOnly ?? null, 'preview');
  });
  delete process.env.VERCEL_ENV;
  globalThis.fetch = orig;
}

/* Upstash refuses requests over 10 MB; a snapshot that would exceed it is trimmed to its
 * newest CRM rows (and says so) instead of silently never being stored again. */
console.log('\nOversized snapshots are trimmed before storing');
{
  const { fitSnapshot } = await import('../api/_snapshot.js');
  const pad = 'x'.repeat(200);
  const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, joined: `2026-09-${String(24 - (i % 20)).padStart(2, '0')}`, hasAttribution: i % 2 === 0, stage: i % 5 === 0 ? 'Customer' : 'Lead', income: 10, qualified: i % 3 === 0, pad }));
  const make = () => {
    const leads = rows('l', 400), sales = rows('s', 400), calls = rows('c', 50), subscriptions = rows('u', 10);
    return {
      schema: 2, generatedAt: '2026-09-24T00:00:00.000Z', warnings: [],
      crm: {
        leads, sales, calls, subscriptions, stages: [], window: { from: 'a', to: 'b' },
        sync: { incremental: false, leadsFetched: 400, syncedAt: 'now', truncated: { leads: false, sales: false, calls: false, subscriptions: false } },
        totals: { leads: 400, attributed: 200, customers: 80, income: 4000, calls: 50, qualifiedCalls: 17, subscriptions: 10 },
      },
    };
  };
  const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
  const small = make();
  const fittedSmall = fitSnapshot?.(small, 10 * 1024 * 1024);
  check('a snapshot under the limit is returned unchanged', Boolean(fittedSmall) && JSON.stringify(fittedSmall) === JSON.stringify(small), true);
  const big = make();
  const before = bytes(big);
  const limit = Math.floor(before / 2);
  const fitted = fitSnapshot?.(big, limit);
  check('an oversized snapshot ends up under the limit', Boolean(fitted) && bytes(fitted) <= limit, true);
  check('the biggest lists were trimmed, the small ones kept', Boolean(fitted) && fitted.crm.leads.length < 400 && fitted.crm.sales.length < 400 && fitted.crm.calls.length === 50 && fitted.crm.subscriptions.length === 10, true);
  check('the newest rows are the ones kept', fitted?.crm.leads[0]?.id, 'l0');
  check('trimmed lists are flagged truncated', Boolean(fitted) && fitted.crm.sync.truncated.leads === true && fitted.crm.sync.truncated.sales === true && fitted.crm.sync.truncated.calls === false, true);
  check('totals are recomputed from the kept rows', Boolean(fitted) && fitted.crm.totals.leads === fitted.crm.leads.length && fitted.crm.totals.calls === 50, true);
  check('a "truncated" warning names the size cap', Boolean(fitted) && fitted.warnings.some((w) => w.kind === 'truncated' && w.level === 'crm' && /MB/.test(w.error)), true);
  check('the original snapshot object is not mutated', big.crm.leads.length, 400);
}


console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll store + API contract checks pass.\n');
process.exit(fails ? 1 : 0);
