import {
  CATALOG, CATALOG_BY_KEY, DEFAULT_KEYS, formatCell, fmt, aggregate, rollup,
} from './shared/metrics.js';
import {
  buildDemoSnapshot, applyAttribution, demoCohort, demoRecords, demoJourney,
} from './demo.js';
import { loadFeatures, applyDemoFeatures, needsMet } from './shared/features.js';

/* Level model mirrors HYROS's own naming for Meta (SourceNamingUtils.ts):
   SOURCE_CATEGORY renders as "Campaign", SOURCE_LINK as "Ad Set". */
const LEVELS = [
  { key: 'traffic',  label: 'Traffic source' },
  { key: 'account',  label: 'Account' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'adset',    label: 'Ad Set' },
  { key: 'ad',       label: 'Ad' },
];
const LEVEL_LABEL = Object.fromEntries(LEVELS.map((l) => [l.key, l.label]));

/* Clicking a row NAME descends the hierarchy (HYROS-style drilldown). */
const CHILD_LEVEL = { traffic: 'campaign', account: 'campaign', campaign: 'adset', adset: 'ad' };

/* HYROS-attributed columns wear the lavender band (the site's HYROS-column signature). Cosmetic only. */
const HY = new Set(['revenue', 'roas']);
const KPI_HY = 'revenue';

const KPIS = [
  { key: 'cost',    label: 'Cost',    type: 'money' },
  { key: 'revenue', label: 'Revenue', type: 'money' },
  { key: 'profit',  label: 'Profit',  type: 'money', tone: true },
  { key: 'roas',    label: 'ROAS',    type: 'ratio' },
  { key: 'sales',   label: 'Sales',   type: 'int' },
  { key: 'leads',   label: 'Leads',   type: 'int' },
  { key: 'calls',   label: 'Calls',   type: 'int' },
  { key: 'clicks',  label: 'Clicks',  type: 'int' },
];

/* Which drawer a drilled cell opens. */
const DRILL_METRIC = {
  leads: 'leads', newLeads: 'leads',
  sales: 'sales', uniqueSales: 'sales',
  calls: 'calls', qualifiedCalls: 'calls',
};

const state = {
  key: sessionStorage.getItem('aihyros_key') || '',
  snapshot: null,
  origin: 'seed',
  capabilities: {},
  serverPrefs: null,
  range: '7d',
  level: 'campaign',
  path: [],                       // hierarchy crumbs: {level, id, name}
  sort: { col: 'cost', dir: 'desc' },
  search: '',
  hideZero: false,
  cols: [...DEFAULT_KEYS],
  crm: { tab: 'leads', stage: '', attr: '', search: '', sort: { col: 'joined', dir: 'desc' } },
  demo: false,                    // demo mode: synthetic snapshot, demo-served drills
  demoModel: 'last',              // demo attribution model: 'last' | 'custom'
  account: localStorage.getItem('aihyros_account') || null,    // selected account id (null = server default)
  accounts: [],                   // from /api/accounts (ids + labels, never keys)
  setup: null,                    // /api/setup state: needs_storage | needs_setup | ready
  features: [],                   // loaded feature modules (public/features/<id>/), see FEATURES.md
  templateVersion: null,          // from /api/data (the template this deployment runs)
  health: null,                   // last /api/health answer (tool list check), for Setup & security
  lastRefresh: null,              // last Refresh / first build outcome (steps, warnings, error) for diagnostics
};

/* Where to report a problem with the template (the docs owner keeps this current). */
const REPO_URL = 'https://github.com/Hyros-AI/hyros-ai';

const ACCOUNT_SCOPED = new Set(['/api/data', '/api/refresh', '/api/drill', '/api/prefs', '/api/health']);

/* Demo mode caches: the real snapshot to restore, and both attribution views. */
let realCache = null;
let demoSnaps = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Column order IS state.cols order (drag & drop reorders it). */
function activeCols() {
  return state.cols.map((k) => CATALOG_BY_KEY.get(k)).filter(Boolean);
}

function resolveCols() {
  try {
    const stored = JSON.parse(localStorage.getItem('aihyros_cols'));
    if (Array.isArray(stored) && stored.length) {
      state.cols = stored.filter((k) => CATALOG_BY_KEY.has(k));
      return;
    }
  } catch { /* fall through */ }
  const server = state.serverPrefs?.cols;
  state.cols = Array.isArray(server) && server.length
    ? server.filter((k) => CATALOG_BY_KEY.has(k))
    : [...DEFAULT_KEYS];
}

function persistColsLocal() {
  localStorage.setItem('aihyros_cols', JSON.stringify(state.cols));
}

/* ------------------------------------------------------------------ *
 * Data access
 * ------------------------------------------------------------------ */

/**
 * Authenticated fetch. The password travels ONLY in the x-report-key header
 * (never `?key=` — a URL lands in logs, history and shared links); the
 * selected account id rides in the query for the account-scoped routes.
 */
async function api(path, opts = {}) {
  const url = new URL(path, location.origin);
  if (ACCOUNT_SCOPED.has(url.pathname) && state.account) {
    url.searchParams.set('account', state.account);
  }
  const headers = { ...(opts.headers || {}), ...(state.key ? { 'x-report-key': state.key } : {}) };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) throw new Error('unauthorized');
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    // Not JSON: Vercel's own error page when the function was killed (60 s)
    // or a 5xx. Carry a code so the copy can say what to do.
    throw Object.assign(new Error(`HTTP ${res.status} — the server did not answer with JSON`),
      { code: res.status >= 500 ? 'timeout' : 'bad_response' });
  }
}

/* ---------- failure copy: what to DO for each error code ---------- */

const KEY_COPY = 'HYROS rejected that key — copy it again from HYROS → Settings → API.';
const FAILURE_COPY = {
  auth: KEY_COPY,
  bad_key: KEY_COPY,
  key_invalid: KEY_COPY,
  forbidden: 'The key is valid but this account cannot use the MCP. Ask HYROS support to enable MCP access for it (it is granted per account).',
  rate_limited: 'HYROS is rate-limiting this account; wait a minute and press Refresh.',
  timeout: 'The build ran out of time (large account). Press Refresh again — the refresh is incremental.',
  NOT_CONFIGURED: 'No HYROS API key is available for this account — check that storage is set up and add the account again from the account menu.',
  not_configured: 'No HYROS account is connected yet — add one from the account menu.',
  needs_storage: 'Storage is not set up yet — add the Upstash Redis store first (see the banner).',
};
/* Messages that mean "the function ran out of time / never answered", whatever the code. */
const TIMEOUT_TEXT = /timed out|Failed to fetch|NetworkError|Unexpected token|did not answer with JSON|HTTP 5\d\d|FUNCTION_INVOCATION|<!doctype|<html/i;

/**
 * Actionable text for a failed API answer or a thrown error. Prefers the
 * server's `code` (the MCP error code), then its `error`, then the message
 * shape; falls back to the raw message. Plain text — callers escape it.
 */
function failureCopy(src, fallback = 'Unknown error') {
  const code = src?.code || src?.error || '';
  if (FAILURE_COPY[code]) return FAILURE_COPY[code];
  const message = String(src?.message || fallback || '');
  if (TIMEOUT_TEXT.test(message)) return FAILURE_COPY.timeout;
  return message || fallback;
}

/** A key that HYROS rejected can be replaced in place — say so next to the copy. */
const isKeyFailure = (src) => ['auth', 'bad_key', 'key_invalid'].includes(src?.code || src?.error || '');
const replaceKeyHint = ' Open the account selector and use <b>Replace key</b>.';

/** Placeholder snapshot for an account that has no build yet. */
function emptySnapshot() {
  const a = state.accounts.find((x) => x.id === state.account);
  return {
    schema: 2, generatedAt: null, origin: 'none', attributionModel: '—',
    settings: { model: 'LAST_CLICK', windowDays: 0, leadStage: [] },
    account: { email: a?.label || a?.email || 'New account' },
    adAccounts: [], sourceCount: 0, ranges: {}, crm: { leads: [], sales: [], calls: [], subscriptions: [], stages: [], totals: {} },
  };
}

async function load() {
  const { body } = await api('/api/data');
  state.origin = body.origin;
  state.templateVersion = body.templateVersion || state.templateVersion;
  state.capabilities = body.capabilities || {};
  state.serverPrefs = body.prefs || null;
  if (body.account && !state.account) state.account = body.account;
  state.snapshot = body.snapshot || emptySnapshot();
  fmt.currency = fmt.currencyCode(state.snapshot.account?.currency); // HYROS reports in the account currency; validated
  pickValidRange();
}

/* ------------------------------------------------------------------ *
 * Gate
 * ------------------------------------------------------------------ */

$('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.key = $('gateKey').value.trim();
  try {
    await load();
    sessionStorage.setItem('aihyros_key', state.key);
    afterSignIn();
  } catch {
    $('gateErr').hidden = false;
    $('gateErr').textContent = 'Incorrect password.';
  }
});
$('gateDemo').addEventListener('click', () => startDemoOnly());

/**
 * Boot: ask the (unauthenticated) setup route what this deployment still
 * needs, then route to the storage gate, the first-run password screen, the
 * sign-in gate, or straight into the dashboard.
 */
async function boot() {
  try {
    const res = await fetch(`${location.origin}/api/setup`);
    state.setup = await res.json();
  } catch { state.setup = null; }
  const st = state.setup?.state;
  if (st === 'needs_storage') { startDemoOnly({ overlay: 'storage' }); return; }
  if (st === 'needs_setup') { showSetup('connect'); return; }
  try {
    await load();
    afterSignIn();
  } catch {
    $('gate').hidden = false;
  }
}

/** Signed in: the dashboard (Demo account if nothing is connected yet). */
function afterSignIn() {
  start();
}

async function start() {
  $('gate').hidden = true;
  $('setup').hidden = true;
  $('app').hidden = false;
  resolveCols();
  await mountFeatures();
  await loadAccounts();
  const hasAccounts = state.accounts.length > 0;
  if (!hasAccounts || sessionStorage.getItem('aihyros_demo') === '1') {
    setDemo(true, { silent: true });
    if (!hasAccounts && state.setup?.state !== 'needs_storage') {
      note('<b>Demo account.</b> No HYROS account is connected yet — open the account menu (top left) and add your API key to see your own data.');
    }
  } else {
    if (state.demo) {
      // Leaving the Demo account for a freshly loaded real one: the loaded
      // snapshot is what must survive, not the pre-demo cache.
      realCache = { snapshot: state.snapshot, origin: state.origin };
      setDemo(false, { silent: true });
    }
    renderChrome();
    renderRangeChips();
    renderLevelChips();
    renderReport();
    renderCrm();
    if (state.origin === 'none') firstBuild();
  }
  renderSetupBanner();
  initHProxy();
}

/**
 * Demo-only: the dashboard with just the Demo account (no storage yet, or
 * the visitor chose the demo from the gate). Nothing here calls the API.
 */
function startDemoOnly({ overlay = null } = {}) {
  $('gate').hidden = true;
  $('app').hidden = false;
  state.accounts = [];
  state.accountsMeta = { canAdd: false, message: overlay === 'storage' ? 'Set up storage first (see the banner).' : 'Sign in to add accounts.' };
  resolveCols();
  mountFeatures().then(() => { setDemo(true, { silent: true }); renderAcctPanel(); renderSetupBanner(); initHProxy(); if (overlay) showSetup(overlay, { overlay: true }); });
}

/* ------------------------------------------------------------------ *
 * First-run setup + Setup & security
 * ------------------------------------------------------------------ */

const SETUP_STEPS = ['storage', 'connect', 'harden'];

function showSetup(step, { overlay = false } = {}) {
  const box = $('setup');
  box.hidden = false;
  box.classList.toggle('is-overlay', overlay);
  ['setupStorage', 'setupConnect', 'setupAccount', 'setupHarden', 'setupSecurity'].forEach((id) => { $(id).hidden = true; });
  $(`setup${step[0].toUpperCase()}${step.slice(1)}`).hidden = false;
  $('setupSteps').hidden = step === 'security' || step === 'account';
  const idx = SETUP_STEPS.indexOf(step);
  $('setupSteps').querySelectorAll('li').forEach((li) => {
    const i = SETUP_STEPS.indexOf(li.dataset.step);
    li.className = i < idx ? 'done' : i === idx ? 'now' : '';
  });
  if (step === 'harden') loadSecrets();
  if (step === 'security') renderSecurity();
  const focus = { connect: 'setupKey', account: 'setupKey2' }[step];
  if (focus) setTimeout(() => $(focus).focus(), 50);
}

function hideSetup() { $('setup').hidden = true; $('setup').classList.remove('is-overlay'); }

/**
 * Re-read the setup state. Signed in, the password travels in the header so
 * the full object (accounts, storeVia, secret sources) comes back; before
 * sign-in the route answers only { state, storage, pendingSecrets }.
 */
async function refreshSetupState() {
  try {
    const res = await fetch(`${location.origin}/api/setup`, { headers: state.key ? { 'x-report-key': state.key } : {} });
    state.setup = await res.json();
  } catch { /* keep the old state */ }
  return state.setup;
}

function renderSetupBanner() {
  const b = $('setupBanner');
  const st = state.setup?.state;
  if (st === 'needs_storage') {
    b.hidden = false;
    b.innerHTML = '<b>Storage is not set up</b> — this is the Demo account only. Your own data needs the free Upstash Redis store. <button type="button" id="bannerSetup">Show me how</button>';
    $('bannerSetup').addEventListener('click', () => showSetup('storage', { overlay: true }));
  } else if (state.key && state.accounts.length === 0 && st !== undefined) {
    b.hidden = false;
    b.innerHTML = '<b>Demo account only</b> — connect your HYROS API key to see your own data. <button type="button" id="bannerKey">Connect HYROS</button>';
    $('bannerKey').addEventListener('click', () => showSetup('account'));
  } else {
    b.hidden = true;
    b.innerHTML = '';
  }
}

// Storage gate
$('setupCheck').addEventListener('click', async () => {
  const btn = $('setupCheck');
  btn.disabled = true; btn.textContent = 'Checking…';
  const st = await refreshSetupState();
  btn.disabled = false; btn.textContent = 'Check again';
  if (st?.state === 'needs_storage') {
    $('setupStorageErr').hidden = false;
    $('setupStorageErr').textContent = 'Still no storage variables on this deployment. Did you redeploy after connecting the database?';
    return;
  }
  location.reload();
});
$('setupDemo').addEventListener('click', () => hideSetup());

// First run: HYROS key + dashboard password in one step (the key is optional)
async function runFirstSetup({ apiKey, agency, password }) {
  const res = await fetch(`${location.origin}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setup', password, apiKey, agency }) });
  const body = await res.json().catch(() => ({ ok: false, code: res.status >= 500 ? 'timeout' : 'bad_response', message: `HTTP ${res.status}` }));
  if (!body.ok) throw new Error(failureCopy(body));
  state.key = password;
  sessionStorage.setItem('aihyros_key', password);
  sessionStorage.setItem('aihyros_demo', '');
  state.setup = { ...(state.setup || {}), ...body };
  if (body.account) { state.account = body.account.id; localStorage.setItem('aihyros_account', state.account); }
  await load().catch(() => {});
  await start();
  if (body.account && body.clientsFound > 0 && body.clientsApproved > 0) await importAgencyClients(body.account.id, body.account.label);
  if (state.setup?.pendingSecrets) showSetup('harden', { overlay: true });
}

$('setupConnectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = $('setupKey').value.trim();
  const p1 = $('setupPw1').value; const p2 = $('setupPw2').value;
  const err = $('setupConnectErr'); const btn = $('setupConnectBtn');
  err.hidden = true;
  if (!apiKey) { err.hidden = false; err.textContent = 'Paste your HYROS API key, or use the link below to set only the password.'; return; }
  if (p1.length < 8) { err.hidden = false; err.textContent = 'Use at least 8 characters for the password.'; return; }
  if (p1 !== p2) { err.hidden = false; err.textContent = 'The two passwords differ.'; return; }
  btn.disabled = true; btn.textContent = 'Checking the key with HYROS…';
  try { await runFirstSetup({ apiKey, agency: $('setupAgency').checked, password: p1 }); $('setupKey').value = ''; }
  catch (ex) { err.hidden = false; err.textContent = failureCopy(ex); }
  finally { btn.disabled = false; btn.textContent = 'Connect & build my dashboard'; }
});
$('setupSkipKey').addEventListener('click', async () => {
  const p1 = $('setupPw1').value; const p2 = $('setupPw2').value;
  const err = $('setupConnectErr');
  err.hidden = true;
  if (p1.length < 8) { err.hidden = false; err.textContent = 'Choose the dashboard password first (8+ characters).'; return; }
  if (p1 !== p2) { err.hidden = false; err.textContent = 'The two passwords differ.'; return; }
  try { await runFirstSetup({ apiKey: '', agency: false, password: p1 }); }
  catch (ex) { err.hidden = false; err.textContent = failureCopy(ex); }
});

// Connect a key later (banner / account menu), once signed in
$('setupKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = $('setupKey2').value.trim();
  const btn = $('setupConnect2'); const err = $('setupKeyErr');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Checking the key with HYROS…';
  try {
    const { body } = await api('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey, agency: $('setupAgency2').checked }) });
    if (!body.ok) { err.hidden = false; err.textContent = failureCopy(body); return; }
    $('setupKey2').value = '';
    sessionStorage.setItem('aihyros_demo', '');
    state.account = body.account.id;
    localStorage.setItem('aihyros_account', state.account);
    await refreshSetupState();
    await load().catch(() => {});
    await start();
    if (body.clientsFound > 0 && body.clientsApproved > 0) await importAgencyClients(body.account.id, body.account.label);
    if (state.setup?.pendingSecrets) showSetup('harden', { overlay: true });
  } catch (ex) { err.hidden = false; err.textContent = failureCopy(ex); }
  finally { btn.disabled = false; btn.textContent = 'Connect & build my dashboard'; }
});
$('setupSkipKey2').addEventListener('click', () => hideSetup());

// Hardening
async function loadSecrets() {
  $('secretKey').textContent = '…'; $('secretCron').textContent = '…';
  try {
    const { body } = await api('/api/setup?secrets=1');
    const sec = body.secrets || {};
    $('secretKey').textContent = sec.ACCOUNT_KEY_SECRET || (state.setup?.keySecret === 'env' ? 'already set in Vercel' : '—');
    $('secretCron').textContent = sec.CRON_SECRET || (state.setup?.cronSecret === 'env' ? 'already set in Vercel' : '—');
    $('setupHardenStatus').textContent = (!sec.ACCOUNT_KEY_SECRET && !sec.CRON_SECRET) ? 'Both secrets already live in Vercel — nothing left to do.' : '';
  } catch (err) { $('setupHardenStatus').textContent = `Could not load the secrets: ${err.message}`; }
}
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const text = $(b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select & copy'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 1500);
}));
$('setupHardenBtn').addEventListener('click', async () => {
  const st = $('setupHardenStatus');
  st.textContent = 'Checking Vercel…';
  try {
    const { body } = await api('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'harden' }) });
    if (!body.ok) { st.textContent = body.message || body.error; return; }
    const left = Object.entries(body.remaining).filter(([, v]) => v).map(([k]) => k);
    if (!left.length) { st.textContent = 'Hardened — the generated copies were removed from the database.'; await refreshSetupState(); setTimeout(() => { hideSetup(); if ($('app').hidden) start(); }, 900); }
    else st.textContent = `${left.join(' and ')} in Vercel ${left.length === 1 ? 'does' : 'do'} not match yet — did you redeploy after adding ${left.length === 1 ? 'it' : 'them'}? (Only matching values are removed, so nothing can be locked out.)`;
  } catch (err) { st.textContent = err.message; }
});
$('setupHardenLater').addEventListener('click', () => { hideSetup(); if ($('app').hidden) start(); });

// Setup & security (from the account menu)
const templateVersion = () => state.templateVersion || state.setup?.templateVersion || state.health?.templateVersion || null;

/** What the tools/list check says, for the facts list. */
function toolsFact() {
  const h = state.health;
  if (!state.accounts.length) return 'no account connected — nothing to check';
  if (!h) return 'checking…';
  if (h.error || !Array.isArray(h.missingTools)) return `could not check (${h.message || h.error || 'no answer'})`;
  if (!h.missingTools.length) return `all ${h.toolCount ?? ''} present`.replace('all  present', 'all present');
  return `${h.missingTools.length} missing: ${h.missingTools.join(', ')}`;
}

function renderSecurity() {
  const st = state.setup || {};
  const facts = [
    ['Template version', templateVersion() || '—'],
    ['Storage', st.storage ? `connected (${st.storeVia})` : 'not set up'],
    ['Password', st.passwordSource === 'kv' ? `set on this dashboard${st.masterPassword ? ' (+ REPORT_PASSWORD master password in Vercel)' : ''}` : 'none'],
    ['Key encryption secret', st.keySecret === 'env' ? 'ACCOUNT_KEY_SECRET in Vercel' : st.keySecret === 'kv' ? 'generated, stored in the database' : 'none'],
    ['Daily refresh', st.cronSecret === 'env' ? 'signed (CRON_SECRET in Vercel)' : 'unsigned — once per hour at most; set CRON_SECRET to sign it'],
    ['HYROS MCP', st.mcpUrl || '—'],
    ['MCP tools', toolsFact()],
    ['Accounts', String(st.accounts ?? state.accounts.length)],
  ];
  $('setupFacts').innerHTML = facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  $('setupChangePw').hidden = st.passwordSource !== 'kv';
  $('secHardenBlock').hidden = !st.pendingSecrets;
  $('reportProblem').href = `${REPO_URL}/issues`;
  $('changePwStatus').textContent = ''; $('resetStatus').textContent = ''; $('resetConfirm').value = ''; $('resetBtn').disabled = true;
  $('diagStatus').textContent = '';
}

/** Ask /api/health which of the tools the app needs the key can see; re-render the facts when it answers. */
async function loadHealth() {
  if (!state.key || !state.accounts.length) { state.health = null; return; }
  try {
    const { body } = await api('/api/health');
    state.health = body;
  } catch (err) {
    state.health = { ok: false, error: err.code || 'error', message: failureCopy(err) };
  }
  if (!$('setupSecurity').hidden) renderSecurity();
}

/* Anything that looks like an email is dropped from the diagnostics text, whatever field it came from. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * The diagnostics JSON: versions, states, counts, the last refresh's steps
 * and warnings, missing tools. Never keys, passwords or emails — account
 * labels are emails, so only ids and counts travel.
 */
function diagnostics() {
  const st = state.setup || {};
  const s = state.demo ? null : state.snapshot;
  const out = {
    templateVersion: templateVersion(),
    at: new Date().toISOString(),
    setup: st.state || null,
    storeVia: st.storeVia || null,
    pendingSecrets: Boolean(st.pendingSecrets),
    accounts: state.accounts.length,
    account: state.account || null,
    demo: state.demo,
    origin: state.origin,
    snapshot: s ? {
      schema: s.schema ?? null, generatedAt: s.generatedAt || null, templateVersion: s.templateVersion || null,
      adAccounts: (s.adAccounts || []).length, sources: s.sourceCount ?? null, sourcesTruncated: Boolean(s.sourcesTruncated),
      ranges: Object.fromEntries(Object.entries(s.ranges || {}).map(([k, r]) => [k, r?.skipped ? `skipped: ${r.skipped}` : 'ok'])),
      crm: { leads: (s.crm?.leads || []).length, sync: s.crm?.sync || null },
      warnings: (s.warnings || []).map((w) => ({ adAccountId: w.adAccountId, name: w.name, type: w.type, level: w.level, kind: w.kind, error: w.error })),
      features: state.features.map((f) => ({ id: f.id, block: s[f.id] ? (s[f.id].error ? 'error' : s[f.id].skipped ? `skipped: ${s[f.id].skipped}` : 'ok') : 'absent' })),
    } : null,
    lastRefresh: state.lastRefresh,
    missingTools: Array.isArray(state.health?.missingTools) ? state.health.missingTools : null,
    health: state.health ? { ok: state.health.ok, toolCount: state.health.toolCount ?? null, error: state.health.error || null } : null,
    userAgent: navigator.userAgent,
  };
  return JSON.stringify(out, null, 2).replace(EMAIL_RE, '<email>');
}

$('copyDiag').addEventListener('click', async () => {
  const text = diagnostics();
  const st = $('diagStatus');
  const btn = $('copyDiag');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied'; st.innerHTML = '';
  } catch {
    // No clipboard (http, permissions): show it for a manual copy.
    st.innerHTML = 'Clipboard unavailable — copy it from here:<textarea class="diag-json" readonly></textarea>';
    st.querySelector('textarea').value = text;
  }
  setTimeout(() => { btn.textContent = 'Copy diagnostics'; }, 1500);
});

$('acctSetupBtn').addEventListener('click', async () => { $('acctPanel').hidden = true; await refreshSetupState(); showSetup('security'); loadHealth(); });
$('setupClose').addEventListener('click', hideSetup);
$('secHardenOpen').addEventListener('click', () => showSetup('harden'));
$('setupChangePw').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = $('changePw1').value; const p2 = $('changePw2').value; const st = $('changePwStatus');
  if (p1 !== p2) { st.textContent = 'The two passwords differ.'; return; }
  try {
    const { body } = await api('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'change-password', password: p1 }) });
    if (!body.ok) { st.textContent = body.message || body.error; return; }
    state.key = p1; sessionStorage.setItem('aihyros_key', p1);
    $('changePw1').value = ''; $('changePw2').value = '';
    st.textContent = 'Password changed. Anyone else signed in will need the new one.';
  } catch (err) { st.textContent = err.message; }
});
$('resetConfirm').addEventListener('input', () => { $('resetBtn').disabled = $('resetConfirm').value.trim() !== 'RESET'; });
$('resetBtn').addEventListener('click', async () => {
  const st = $('resetStatus');
  if (!window.confirm('Delete every account, snapshot, setting and the password from this dashboard? This cannot be undone.')) return;
  st.textContent = 'Resetting…';
  try {
    const { body } = await api('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reset', confirm: 'RESET' }) });
    if (!body.ok) { st.textContent = body.message || body.error; return; }
    sessionStorage.clear(); localStorage.removeItem('aihyros_account');
    st.textContent = `Reset — ${body.deleted} stored items deleted. Reloading…`;
    setTimeout(() => location.reload(), 900);
  } catch (err) { st.textContent = err.message; }
});

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function renderChrome() {
  const s = state.snapshot;
  const gen = new Date(s.generatedAt);
  const attr = String(s.attributionModel || '—')
    .replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
    .replace(/\bhyros\b/i, 'HYROS');
  const upd = Number.isNaN(gen.getTime()) ? '—' : gen.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  // Header: the account SELECTOR carries the account; ad accounts / source
  // count / model live in Tracking Health and the report settings (and the
  // selector's tooltip). Updated time sits by the badge.
  const acct = state.accounts.find((a) => a.id === state.account);
  $('acctLabel').textContent = state.demo ? 'Demo account'
    : (acct?.label || s.account?.email || 'No account');
  $('acctBtn').title = `${state.demo ? 'Synthetic demo data' : (s.adAccounts.map((a) => a.name).join(', ') || 'no ad accounts')} · ${s.sourceCount} sources · ${attr}`;
  // What the last build could not do — ad accounts skipped / rate limited /
  // truncated / out of time, a truncated source list, ranges not fetched —
  // one short line so nothing is silently missing; details in the tooltip.
  $('meta').innerHTML = state.demo ? '' : buildWarningsLine(s);
  $('updated').textContent = s.generatedAt ? `Updated ${upd}` : 'Not built yet';

  const badge = $('originBadge');
  if (state.demo) {
    badge.textContent = 'Demo';
    badge.className = 'badge demo';
    badge.title = 'Demo mode — every number is synthetic. Click to return to your data.';
  } else if (state.origin === 'none') {
    badge.textContent = 'New';
    badge.className = 'badge none';
    badge.title = 'No snapshot yet for this account — building the first one. Click for demo mode.';
  } else {
    const live = state.origin === 'kv';
    badge.textContent = live ? 'Live' : 'Seed';
    badge.className = `badge ${live ? 'live' : 'seed'}`;
    badge.title = (live
      ? 'Snapshot built from the HYROS MCP and stored in your database.'
      : 'Preview snapshot.')
      + ' Click to switch to demo mode.';
  }

  // Demo-only chrome: attribution selector; Refresh pauses. Feature tabs follow their manifests.
  $('attrWrap').hidden = !state.demo;
  $('refreshBtn').disabled = state.demo;
  $('refreshBtn').title = state.demo ? 'Refresh is paused while demo mode is on.' : '';

  // Live-mode chrome: report settings (built into the next refresh) and the
  // two analysis tabs, which appear once a snapshot carries their blocks.
  $('setWrap').hidden = state.demo;
  renderFeatureTabs();
  renderSettingsSummary();
}

/* ---------- build warnings (snapshot.warnings[], sourcesTruncated, skipped ranges) ---------- */

/* warning.kind -> the short word the header uses. Unknown kinds read as "skipped". */
const WARNING_GROUPS = [
  { key: 'skipped',      label: 'skipped',      kinds: ['unsupported', 'error'] },
  { key: 'rate_limited', label: 'rate limited', kinds: ['rate_limited'] },
  { key: 'truncated',    label: 'truncated',    kinds: ['truncated'] },
  { key: 'time budget',  label: 'not fetched (time budget)', kinds: ['time budget'] },
];
const warningGroup = (w) => WARNING_GROUPS.find((g) => g.kinds.includes(w?.kind)) || WARNING_GROUPS[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One line, grouped by kind: "2 ad accounts skipped: A, B · 1 rate limited: C
 * · sources list truncated · 1 range not fetched". Every detail goes in the
 * title so the line itself stays short. Empty string when nothing is wrong.
 */
function buildWarningsLine(s) {
  const warnings = Array.isArray(s?.warnings) ? s.warnings : [];
  const parts = [];
  const details = [];
  for (const g of WARNING_GROUPS) {
    const ws = warnings.filter((w) => warningGroup(w) === g);
    if (!ws.length) continue;
    const names = [...new Set(ws.map((w) => w.name || w.adAccountId || w.level || 'snapshot'))];
    const accountOnly = ws.every((w) => w.adAccountId);
    parts.push(accountOnly
      ? `${plural(names.length, 'ad account')} ${g.label}: ${names.join(', ')}`
      : `${g.label}: ${names.join(', ')}`);
    details.push(...ws.map((w) => `${w.name || w.adAccountId || w.level || 'snapshot'}${w.level ? ` (${w.level})` : ''}: ${w.error || g.label}`));
  }
  if (s?.sourcesTruncated) {
    parts.push('sources list truncated');
    details.push('hyros_get_sources returned more sources than were fetched — ad sets past the cap roll up as Uncategorised / Unknown.');
  }
  const skippedRanges = Object.values(s?.ranges || {}).filter((r) => r?.skipped);
  if (skippedRanges.length) {
    parts.push(`${plural(skippedRanges.length, 'range')} not fetched (${skippedRanges.map((r) => r.label).join(', ')})`);
    details.push(...skippedRanges.map((r) => `${r.label}: not fetched this refresh (${r.skipped}) — press Refresh again.`));
  }
  if (!parts.length) return '';
  return `<span class="warn" title="${esc(details.join('\n'))}">${esc(parts.join(' · '))}</span>`;
}

/* ---------- report settings (attribution model / window / stage ranking) ---------- */

function currentSettings() {
  return state.serverPrefs?.settings || state.snapshot?.settings
    || { model: state.snapshot?.attributionModel || 'LAST_CLICK', windowDays: 0, leadStage: [] };
}

function renderSettingsSummary() {
  const s = state.snapshot?.settings;
  if (!s || state.demo) return;
  const bits = [];
  if (s.windowDays > 0) bits.push(`<span class="meta-pill" title="Attribution window">${s.windowDays}-day window</span>`);
  if (s.leadStage?.length) bits.push(`<span class="meta-pill" title="Report ranked by funnel stage">stage: ${esc(s.leadStage.join(', '))}</span>`);
  if (bits.length) $('meta').insertAdjacentHTML('beforeend', bits.join(''));
}

function renderSettingsPanel() {
  const cur = currentSettings();
  $('setModel').value = cur.model || 'LAST_CLICK';
  $('setWindow').value = String(cur.windowDays || 0);
  $('setWindow').disabled = $('setModel').value !== 'LAST_CLICK';
  const stages = (state.snapshot?.crm?.stages || []).filter((st) => st.name && st.name.trim());
  const picked = new Set(cur.leadStage || []);
  $('setStages').innerHTML = stages.length
    ? stages.map((st) => `<button type="button" class="chip ${picked.has(st.name) ? 'active' : ''}" data-stage="${esc(st.name)}">${esc(st.name)}</button>`).join('')
    : '<div class="empty">No stages in this snapshot yet.</div>';
  $('setStages').querySelectorAll('.chip').forEach((b) =>
    b.addEventListener('click', () => b.classList.toggle('active')));
  $('setStatus').textContent = 'Applies on the next Refresh.';
}

function readSettingsPanel() {
  return {
    model: $('setModel').value,
    windowDays: Math.max(0, Math.min(365, Number($('setWindow').value) || 0)),
    leadStage: [...$('setStages').querySelectorAll('.chip.active')].map((b) => b.dataset.stage),
  };
}

$('setBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('setPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderSettingsPanel();
});
$('setPanel').addEventListener('click', (e) => e.stopPropagation());
$('setModel').addEventListener('change', () => { $('setWindow').disabled = $('setModel').value !== 'LAST_CLICK'; });
document.addEventListener('click', () => { $('setPanel').hidden = true; });

$('setSaveBtn').addEventListener('click', async () => {
  const btn = $('setSaveBtn');
  const settings = readSettingsPanel();
  btn.disabled = true;
  $('setStatus').textContent = 'Saving…';
  try {
    const { body } = await api('/api/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    if (!body.persisted) {
      $('setStatus').textContent = body.message || 'Not saved — KV is not configured.';
      return;
    }
    state.serverPrefs = { ...(state.serverPrefs || {}), settings };
    $('setStatus').textContent = 'Saved — rebuilding…';
    $('setPanel').hidden = true;
    $('refreshBtn').click();
  } catch (err) {
    $('setStatus').textContent = `Save failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

/* ---------- account selector ---------- */

async function loadAccounts() {
  try {
    const { body } = await api('/api/accounts');
    state.accounts = body.accounts || [];
    state.accountsMeta = { canAdd: Boolean(body.canAdd), message: body.message || '' };
    if (!state.accounts.some((a) => a.id === state.account)) {
      state.account = body.defaultId || state.accounts[0]?.id || null;
      if (state.account) localStorage.setItem('aihyros_account', state.account); else localStorage.removeItem('aihyros_account');
    }
  } catch { state.accounts = []; state.accountsMeta = { canAdd: false, message: '' }; }
}

/** Why an account can't be opened right now (null = fine). */
function acctBlock(a) {
  // Approval state first (it is what the user must fix in HYROS), then key health.
  if (a.kind === 'client' && a.status === 'PENDING') return { text: 'pending approval', why: 'HYROS has not approved the agency\u2019s access to this client yet.' };
  if (a.kind === 'client' && a.status === 'REVOKED') return { text: 'access revoked', why: 'This client no longer appears in the agency\u2019s accessible accounts.' };
  if (a.kind === 'client' && a.status !== 'APPROVED') return { text: String(a.status || '').toLowerCase(), why: 'Not approved.' };
  if (a.keyStatus === 'invalid') return { text: 'key invalid', why: a.keyError || 'HYROS rejected this key.', fix: a.kind === 'client' ? null : a.id };
  return null;
}

function acctRowHtml(a, parent) {
  const block = acctBlock(a);
  const unsupported = a.kind === 'client' && parent?.clientModeStatus === 'unsupported';
  const disabled = Boolean(block) || unsupported;
  const sub = a.primary ? 'primary · from environment'
    : a.kind === 'client' ? `via ${esc(parent?.label || 'agency')}`
    : a.agency ? `agency${a.clientsSyncedAt ? ` · clients synced ${esc(fmt.date(a.clientsSyncedAt))}` : ''}`
    : esc(a.company || a.email || '');
  const when = a.lastRefresh ? ` · updated ${esc(fmt.date(a.lastRefresh))}` : (disabled ? '' : ' · not built yet');
  const pills = [
    a.primary ? '<span class="pill">primary</span>' : '',
    a.agency ? '<span class="pill">agency</span>' : '',
    block ? `<span class="pill warnk" title="${esc(block.why)}">${esc(block.text)}</span>` : '',
    unsupported ? '<span class="pill warnk" title="The HYROS MCP does not honor accessible_account_id yet — clients cannot be read through the agency key. Listed so they light up the moment the API supports it.">MCP: no client access yet</span>' : '',
    a.lastError && !block ? `<span class="pill warnk" title="${esc(a.lastError)}">last refresh failed</span>` : '',
    block?.fix ? `<button type="button" class="acct-fix" data-fix="${esc(block.fix)}">Replace key</button>` : '',
  ].join('');
  return `<button type="button" class="acct-row ${a.kind === 'client' ? 'client' : ''} ${!state.demo && a.id === state.account ? 'active' : ''} ${disabled ? 'disabled' : ''}"
      data-id="${esc(a.id)}" ${disabled ? `data-blocked="${esc(block?.why || 'unsupported')}"` : ''} title="${esc(block?.why || '')}">
    <span><b>${esc(a.label || a.email || a.id)}</b><span class="sub">${sub}${when}</span></span>
    <span class="pills">${pills}</span>
    ${a.primary ? '<span></span>' : `<span class="acct-x" data-remove="${esc(a.id)}" title="Remove ${a.agency ? 'this agency and its clients' : 'this account'}">✕</span>`}
  </button>`;
}

function renderAcctPanel() {
  const accounts = state.accounts;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const tops = accounts.filter((a) => a.kind !== 'client');
  const rows = tops.map((a) => acctRowHtml(a) + accounts.filter((c) => c.kind === 'client' && c.parentId === a.id)
    .map((c) => acctRowHtml(c, byId.get(c.parentId))).join('')).join('');

  const last = accounts.map((a) => a.lastRefresh).filter(Boolean).sort().pop();
  const built = accounts.filter((a) => a.lastRefresh).length;
  $('acctHead').innerHTML = last
    ? `Last refresh <b>${esc(fmt.datetime(last))}</b> · ${built}/${accounts.length} built · daily auto-refresh`
    : (accounts.length ? 'No refresh yet · daily auto-refresh' : 'Accounts');

  $('acctList').innerHTML = `${rows || '<div class="empty" style="padding:10px">No accounts connected yet.</div>'}
    <button type="button" class="acct-row ${state.demo ? 'active' : ''}" data-id="demo">
      <span><b>Demo account</b><span class="sub">synthetic, profitable-looking data for demos</span></span>
      <span class="pills"><span class="pill demo">demo</span></span><span></span>
    </button>`;

  $('acctList').querySelectorAll('.acct-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.dataset.remove) { e.stopPropagation(); removeAccount(e.target.dataset.remove); return; }
      if (e.target.dataset.fix) { e.stopPropagation(); openReplaceKey(e.target.dataset.fix); return; }
      if (row.dataset.blocked) { e.stopPropagation(); return; }
      $('acctPanel').hidden = true;
      if (row.dataset.id === 'demo') { setDemo(true); return; }
      switchAccount(row.dataset.id);
    });
  });

  const meta = state.accountsMeta || {};
  $('acctAddBtn').disabled = !meta.canAdd;
  $('acctAddBtn').title = meta.canAdd ? '' : (meta.message || 'Adding accounts is not enabled on this deployment.');
}

/** Register an agency's clients 5 at a time, reporting progress in the panel. */
async function importAgencyClients(agencyId, label) {
  let offset = 0; let total = 0; let done = 0; let result = null;
  const status = $('acctStatus');
  for (let guard = 0; guard < 60; guard += 1) {
    status.className = 'sub';
    status.textContent = total ? `Adding client accounts… ${done} of ${total}` : 'Finding client accounts…';
    const { body } = await api('/api/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'import-clients', id: agencyId, offset }),
    });
    if (!body.ok) { status.className = 'sub err'; status.textContent = body.message || body.error; return null; }
    result = body; total = body.total; offset = body.offset; done = offset;
    if (!body.remaining) break;
  }
  await loadAccounts();
  renderAcctPanel();
  if (!result) return null;
  const pend = result.pending ? ` ${result.pending} more awaiting HYROS approval.` : '';
  if (result.clientModeStatus === 'unsupported') {
    note(`<b>${esc(label)}</b>: found ${total} client accounts and listed them, but the HYROS MCP does not honor <code>accessible_account_id</code> yet (${esc(result.clientModeError || 'probe failed')}). They'll become loadable the moment the API supports it — no re-adding needed.${pend}`, true);
  } else {
    note(`<b>${esc(label)}</b>: added ${total} client accounts (client access verified via <code>${esc(result.clientMode)}</code>). They build on the daily refresh cycle, or pick one now to build it immediately.${pend}`);
  }
  return result;
}

function openReplaceKey(id) {
  const a = state.accounts.find((x) => x.id === id);
  $('acctForm').dataset.replace = id;
  $('acctFormTitle').textContent = `New HYROS API key for ${a?.label || id}`;
  $('acctAgencyRow').hidden = true;
  $('acctAddBtn').hidden = true;
  $('acctForm').hidden = false;
  $('acctStatus').className = 'sub';
  $('acctStatus').textContent = 'The replacement key must belong to the same HYROS account.';
  $('acctKey').value = '';
  $('acctKey').focus();
}

async function switchAccount(id) {
  if (state.demo) setDemo(false, { silent: true });
  if (id === state.account && state.origin !== 'none') return;
  const previous = state.account;
  state.account = id;
  localStorage.setItem('aihyros_account', id);
  state.path = [];
  resetStageFilter();
  note('Loading account…');
  try {
    await load();
    pickValidRange();
    renderChrome(); renderRangeChips(); renderLevelChips(); renderReport(); renderCrm();
    renderActiveFeature();
    $('reportNote').innerHTML = '';
    if (state.origin === 'none') firstBuild();
  } catch (err) {
    // The table still shows the previous account, so the selector must too.
    state.account = previous;
    if (previous) localStorage.setItem('aihyros_account', previous); else localStorage.removeItem('aihyros_account');
    renderChrome();
    if (!$('acctPanel').hidden) renderAcctPanel();
    const label = state.accounts.find((x) => x.id === id)?.label || id;
    note(`Could not load <b>${esc(label)}</b>: ${esc(failureCopy(err))} Still showing the previous account.`, true);
  }
}

/** An account with no snapshot yet: build it now, then reload. */
async function firstBuild() {
  const a = state.accounts.find((x) => x.id === state.account);
  note(`<b>Building the first snapshot for ${esc(a?.label || 'this account')}…</b> pulling reports, CRM, curves and health from the HYROS MCP. Usually under a minute.`);
  const btn = $('refreshBtn');
  btn.disabled = true; btn.textContent = 'Building…';
  try {
    const { body } = await api('/api/refresh', { method: 'POST' });
    recordRefresh(body, 'first build');
    if (!body.ok) {
      note(`First build failed: ${esc(failureCopy(body))}${isKeyFailure(body) ? replaceKeyHint : ''}`, true);
      await loadAccounts();
      return;
    }
    await load();
    await loadAccounts();
    pickValidRange();
    renderChrome(); renderRangeChips(); renderLevelChips(); renderReport(); renderCrm();
    renderActiveFeature();
    note(`Built in ${(body.ms / 1000).toFixed(1)}s.${persistNote(body)}`, !body.persisted);
  } catch (err) {
    recordRefresh({ ok: false, code: err.code, message: err.message }, 'first build');
    note(`First build failed: ${esc(failureCopy(err))}`, true);
  } finally {
    btn.disabled = state.demo; btn.textContent = 'Refresh';
  }
}

async function removeAccount(id) {
  const a = state.accounts.find((x) => x.id === id);
  if (!window.confirm(`Remove ${a?.label || id} from this dashboard? Its stored snapshot and settings are deleted; the HYROS account itself is untouched.`)) return;
  try {
    const { body } = await api(`/api/accounts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!body.ok) { note(body.message || 'Could not remove the account.', true); return; }
    await loadAccounts();
    renderAcctPanel();
    if (state.account === id) {
      if (state.accounts.length) switchAccount(state.accounts[0].id);
      else { state.account = null; localStorage.removeItem('aihyros_account'); setDemo(true, { silent: true }); note('Last account removed — showing the Demo account.'); }
    }
    await refreshSetupState(); renderSetupBanner();
  } catch (err) { note(`Remove failed: ${esc(err.message)}`, true); }
}

$('acctBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('acctPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { renderAcctPanel(); $('acctForm').hidden = true; $('acctAddBtn').hidden = false; }
});
$('acctPanel').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { $('acctPanel').hidden = true; });

$('acctAddBtn').addEventListener('click', () => {
  delete $('acctForm').dataset.replace;
  $('acctFormTitle').textContent = 'HYROS API key for the account to add';
  $('acctAgencyRow').hidden = false;
  $('acctAgency').checked = false;
  $('acctAddBtn').hidden = true;
  $('acctForm').hidden = false;
  $('acctStatus').className = 'sub';
  $('acctStatus').textContent = 'The key is verified against HYROS, encrypted, and never shown again.';
  $('acctKey').value = '';
  $('acctKey').focus();
});
$('acctCancel').addEventListener('click', () => { $('acctForm').hidden = true; $('acctAddBtn').hidden = false; delete $('acctForm').dataset.replace; });

$('acctForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = $('acctKey').value.trim();
  if (!apiKey) return;
  const btn = $('acctConnect');
  const replaceId = $('acctForm').dataset.replace || null;
  const agency = $('acctAgency').checked;
  btn.disabled = true;
  $('acctStatus').className = 'sub';
  $('acctStatus').textContent = 'Checking the key with HYROS…';
  try {
    const { body } = await api('/api/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(replaceId ? { action: 'replace-key', id: replaceId, apiKey } : { apiKey, agency }),
    });
    if (!body.ok) { $('acctStatus').className = 'sub err'; $('acctStatus').textContent = failureCopy(body); return; }
    $('acctKey').value = '';
    await loadAccounts();
    if (replaceId) {
      renderAcctPanel(); $('acctForm').hidden = true; $('acctAddBtn').hidden = false; delete $('acctForm').dataset.replace;
      note(`Key replaced for <b>${esc(body.account.label)}</b> — its clients are loadable again.`);
      return;
    }
    const account = body.account;
    // Agency: either the box was ticked or HYROS reports client accounts — register them in batches of 5.
    if (body.clientsFound > 0 && (agency || body.clientsApproved > 0)) {
      if (agency || window.confirm(`${account.label} has ${body.clientsApproved} approved client account${body.clientsApproved === 1 ? '' : 's'}. Add them all?`)) {
        await importAgencyClients(account.id, account.label);
      }
    }
    $('acctPanel').hidden = true;
    $('acctForm').hidden = true; $('acctAddBtn').hidden = false;
    await refreshSetupState(); renderSetupBanner();
    switchAccount(account.id);
  } catch (err) {
    $('acctStatus').className = 'sub err'; $('acctStatus').textContent = failureCopy(err);
  } finally { btn.disabled = false; }
});

/* ---------- view tabs ---------- */

const CORE_VIEWS = ['report', 'crm'];
const VIEWS = () => [...CORE_VIEWS, ...state.features.filter((f) => f.view).map((f) => f.id)];
const featureById = (id) => state.features.find((f) => f.id === id && f.view) || null;
const isDemoOnlyView = (v) => featureById(v)?.manifest.mode === 'demo';

function selectView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  for (const v of VIEWS()) { const el = $(`view-${v}`); if (el) el.hidden = v !== view; }
  const f = featureById(view);
  if (f) renderFeature(f);
  updateHProxy();
}

function activeView() {
  return VIEWS().find((v) => !$(`view-${v}`).hidden) || 'report';
}

/* ---------- features (public/features/<id>/ — see FEATURES.md) ---------- */

let featuresMounted = null;

/** Load every registered feature once: a tab + a section per feature, its stylesheet linked. */
function mountFeatures() {
  if (featuresMounted) return featuresMounted;
  featuresMounted = (async () => {
    state.features = await loadFeatures();
    const nav = document.querySelector('.tabs');
    const anchor = $('view-crm');
    for (const f of state.features) {
      if (!f.view) { console.warn(`[feature ${f.id}] not loaded: ${f.error}`); continue; }
      const tab = document.createElement('button');
      tab.className = 'tab'; tab.dataset.view = f.id; tab.id = `tab-${f.id}`; tab.hidden = true;
      tab.textContent = f.manifest.tab;
      tab.title = f.manifest.description || '';
      tab.addEventListener('click', () => selectView(f.id));
      nav.appendChild(tab);
      const sec = document.createElement('section');
      sec.className = 'panel feature'; sec.id = `view-${f.id}`; sec.hidden = true; sec.dataset.feature = f.id;
      anchor.insertAdjacentElement('afterend', sec);
      if (f.manifest.style) {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = `/features/${f.id}/style.css`;
        document.head.appendChild(link);
      }
    }
  })();
  return featuresMounted;
}

/** Should this feature's tab show for the current snapshot / mode? */
function featureVisible(f) {
  const s = state.snapshot || {};
  const has = Boolean(s[f.id]) && needsMet(f.manifest, s);
  if (f.manifest.mode === 'demo') return state.demo && has;
  if (f.manifest.mode === 'live') return !state.demo && has;
  return has;
}

function renderFeatureTabs() {
  for (const f of state.features) {
    if (!f.view) continue;
    $(`tab-${f.id}`).hidden = !featureVisible(f);
  }
}

/** The context handed to a feature's render(ctx) — the only API features use. */
function featureCtx(f) {
  return {
    id: f.id, manifest: f.manifest,
    root: $(`view-${f.id}`),
    snapshot: state.snapshot, block: state.snapshot?.[f.id] ?? null,
    demo: state.demo, account: state.account, range: state.range, level: state.level,
    fmt, esc, kpis: kpiTiles, formatCell,
    note, openJourney: (email) => openJourney(email, true),
    api: (path, opts) => api(path, opts),
    selectView,
  };
}

function renderFeature(f) {
  try { f.view.render(featureCtx(f)); }
  catch (err) {
    console.error(`[feature ${f.id}]`, err);
    $(`view-${f.id}`).innerHTML = `<div class="note err"><b>${esc(f.manifest.name)} failed to render.</b> ${esc(err.message)} — see the console; the rest of the dashboard is unaffected.</div>`;
  }
}

function renderActiveFeature() {
  const f = featureById(activeView());
  if (f) renderFeature(f);
}

document.querySelectorAll('.tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => selectView(tab.dataset.view));
});

/* ---------- demo mode ---------- */

function resetStageFilter() {
  const sel = $('stageFilter');
  while (sel.options.length > 1) sel.remove(1);
  sel.value = '';
  state.crm.stage = '';
}

const rangeUsable = (r) => Boolean(r) && !r.skipped;

function pickValidRange() {
  const ranges = state.snapshot.ranges || {};
  if (!rangeUsable(ranges[state.range])) {
    const ok = Object.keys(ranges).find((k) => rangeUsable(ranges[k]));
    if (ok) state.range = ok;
  }
}

function setDemo(on, { silent = false } = {}) {
  if (on === state.demo && !silent) return;
  if (!on && !state.accounts.length) {
    // Nothing to switch back to: the Demo account is the only account.
    note('<b>Demo account.</b> No HYROS account is connected yet — open the account menu (top left) and add your API key to see your own data.');
    return;
  }
  fmt.cents = !on; // whole dollars on the demo projector, cents on real data
  fmt.currency = on ? 'USD' : fmt.currencyCode(state.snapshot?.account?.currency);
  if (on) {
    if (!demoSnaps) {
      const last = buildDemoSnapshot();
      demoSnaps = { last: applyDemoFeatures(last, state.features), custom: applyDemoFeatures(applyAttribution(last), state.features) };
    }
    if (!state.demo) realCache = { snapshot: state.snapshot, origin: state.origin };
    state.snapshot = demoSnaps[state.demoModel];
    state.origin = 'demo';
  } else if (realCache) {
    state.snapshot = realCache.snapshot;
    state.origin = realCache.origin;
  }
  state.demo = on;
  sessionStorage.setItem('aihyros_demo', on ? '1' : '');

  state.path = [];
  resetStageFilter();
  pickValidRange();
  closeDrawer();
  if (!on && isDemoOnlyView(activeView())) selectView('report');
  { const f = featureById(activeView()); if (f && !featureVisible(f)) selectView('report'); }

  renderChrome(); renderRangeChips(); renderLevelChips(); renderReport(); renderCrm();
  renderActiveFeature();

  if (!silent) {
    if (on) {
      note('<b>Demo mode.</b> Everything on screen — report, CRM, drill-downs, journeys — is '
        + 'synthetic, profitable-looking data for demos. No real customer data is shown. '
        + 'Click the DEMO badge to switch back.');
    } else {
      $('reportNote').innerHTML = '';
    }
  }
}

$('originBadge').addEventListener('click', () => setDemo(!state.demo));

/* Attribution model selector (demo-only). */
function setAttrModel(model) {
  state.demoModel = model;
  $('attrBtn').textContent = model === 'custom' ? '⚖ Attribution: Custom HYROS' : '⚖ Attribution: Last Click';
  $('attrPanel').querySelectorAll('.attr-opt').forEach((b) =>
    b.classList.toggle('active', b.dataset.model === model));
  if (!state.demo) return;
  state.snapshot = demoSnaps[model];
  renderChrome(); renderReport();
  renderActiveFeature();
  note(model === 'custom'
    ? '<b>Custom HYROS attribution.</b> Credit is reassigned to the clicks that created the '
      + 'customer — watch prospecting campaigns rise and retargeting / brand search fall. '
      + 'Account totals are identical: attribution moves credit, it never invents revenue.'
    : '<b>Last Click attribution.</b> All credit goes to the final tracked click before the sale.');
}

$('attrBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('attrPanel');
  panel.hidden = !panel.hidden;
});
$('attrPanel').addEventListener('click', (e) => e.stopPropagation());
$('attrPanel').querySelectorAll('.attr-opt').forEach((b) =>
  b.addEventListener('click', () => { $('attrPanel').hidden = true; setAttrModel(b.dataset.model); }));
document.addEventListener('click', () => { $('attrPanel').hidden = true; });

$('refreshBtn').addEventListener('click', async () => {
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const { body } = await api('/api/refresh', { method: 'POST' });
    recordRefresh(body, 'refresh');
    if (body.ok) {
      await load();
      renderChrome(); renderRangeChips(); renderReport(); renderCrm(); renderActiveFeature();
      note(`Refreshed in ${(body.ms / 1000).toFixed(1)}s.${persistNote(body)}`, !body.persisted);
    } else {
      note(`Refresh failed: ${esc(failureCopy(body))}${isKeyFailure(body) ? replaceKeyHint : ''}`, true);
    }
  } catch (err) {
    recordRefresh({ ok: false, code: err.code, message: err.message }, 'refresh');
    note(`Refresh failed: ${esc(failureCopy(err))}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
});

/** Keep the last refresh outcome (for Copy diagnostics): steps, timing, code — never the snapshot itself. */
function recordRefresh(body, kind) {
  state.lastRefresh = {
    kind, at: new Date().toISOString(), account: state.account || null,
    ok: Boolean(body?.ok), ms: body?.ms ?? null, persisted: body?.persisted ?? null,
    code: body?.ok ? null : (body?.code || body?.error || null),
    message: body?.ok ? null : (body?.message || null),
    steps: Array.isArray(body?.steps) ? body.steps.slice(-40) : null,
    counts: body?.counts || null,
  };
}

function note(msg, isErr) {
  $('reportNote').innerHTML = `<div class="note${isErr ? ' err' : ''}">${msg}</div>`;
}

/**
 * Why a refresh answered persisted:false. "KV is not configured" only when
 * the store really is absent (the response's own flag, else what /api/data
 * and /api/setup said); with a store present the write itself failed —
 * almost always a snapshot over the store's value limit.
 */
function persistNote(body) {
  if (body?.persisted) return '';
  if (body?.readOnly === 'preview') return ' Not persisted — preview deployment (read-only).';
  const storage = body?.storeConfigured ?? body?.storage
    ?? (body?.storeVia ? true : undefined)
    ?? state.capabilities?.storeConfigured ?? state.setup?.storage;
  if (storage === false || /KV is not configured/i.test(String(body?.warning || ''))) return ' Not persisted — KV is not configured.';
  return ' Snapshot too large to store — see the account menu.';
}

/* ------------------------------------------------------------------ *
 * Column selector + drag order + save
 * ------------------------------------------------------------------ */

function renderColPanel() {
  const q = ($('colSearch').value || '').toLowerCase();
  const selected = new Set(state.cols);
  const groups = new Map();
  for (const c of CATALOG) {
    if (q && !`${c.l} ${c.k}`.toLowerCase().includes(q)) continue;
    if (!groups.has(c.g)) groups.set(c.g, []);
    groups.get(c.g).push(c);
  }

  $('colGroups').innerHTML = [...groups.entries()].map(([group, entries]) => `
    <div class="col-group">
      <div class="col-group-title">${esc(group)}</div>
      ${entries.map((c) => `
        <label class="col-opt ${c.a === null ? 'nonagg' : ''}"
               title="${c.a === null ? 'Native metric — shows at Ad Set / Ad level; rolled-up Campaign/Traffic rows show —' : ''}">
          <input type="checkbox" data-key="${c.k}" ${selected.has(c.k) ? 'checked' : ''}>
          <span>${esc(c.l)}</span>
          ${c.a === null ? '<span class="pill">native</span>' : ''}
        </label>`).join('')}
    </div>`).join('') || '<div class="empty">No metrics match.</div>';

  $('colCount').textContent = `${state.cols.length} of ${CATALOG.length} columns`;

  $('colGroups').querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      state.cols = cb.checked
        ? [...state.cols, key]
        : state.cols.filter((k) => k !== key);
      persistColsLocal();
      $('colCount').textContent = `${state.cols.length} of ${CATALOG.length} columns`;
      renderReport();
    });
  });
}

$('colBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('colPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderColPanel();
});
$('colPanel').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { $('colPanel').hidden = true; });
$('colSearch').addEventListener('input', renderColPanel);
$('colReset').addEventListener('click', () => {
  localStorage.removeItem('aihyros_cols');
  const server = state.serverPrefs?.cols;
  state.cols = Array.isArray(server) && server.length
    ? server.filter((k) => CATALOG_BY_KEY.has(k)) : [...DEFAULT_KEYS];
  renderColPanel();
  renderReport();
});

$('saveViewBtn').addEventListener('click', async () => {
  const btn = $('saveViewBtn');
  btn.disabled = true;
  try {
    const { body } = await api('/api/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: state.cols }),
    });
    persistColsLocal();
    if (body.persisted) {
      state.serverPrefs = { cols: [...state.cols] };
      note('View saved — this column loadout and order is now the default for everyone.');
    } else {
      note(body.message || 'Saved in this browser only (KV not configured).', true);
    }
  } catch (err) {
    note(`Save failed: ${esc(err.message)}`, true);
  } finally {
    btn.disabled = false;
  }
});

/* Drag & drop on the table header reorders state.cols. */
let dragKey = null;

function wireHeaderDrag(th) {
  const key = th.dataset.col;
  if (key === 'name') return;
  th.draggable = true;
  th.addEventListener('dragstart', (e) => {
    dragKey = key;
    th.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  th.addEventListener('dragend', () => { dragKey = null; th.classList.remove('dragging'); });
  th.addEventListener('dragover', (e) => {
    if (!dragKey || dragKey === key) return;
    e.preventDefault();
    th.classList.add('drop-target');
  });
  th.addEventListener('dragleave', () => th.classList.remove('drop-target'));
  th.addEventListener('drop', (e) => {
    e.preventDefault();
    th.classList.remove('drop-target');
    if (!dragKey || dragKey === key) return;
    const from = state.cols.indexOf(dragKey);
    const to = state.cols.indexOf(key);
    if (from < 0 || to < 0) return;
    state.cols.splice(to, 0, ...state.cols.splice(from, 1));
    persistColsLocal();
    renderReport();
  });
}

/* ------------------------------------------------------------------ *
 * Hierarchy: breadcrumb path filters the ad-set base table
 * ------------------------------------------------------------------ */

const CRUMB_FILTER = {
  traffic:  (a, id) => a._traffic === id,
  account:  (a, id) => a._account === id,
  campaign: (a, id) => a._category === id,
  adset:    (a, id) => a.id === id,
};

function withTags(rows, adsets, keyOf) {
  return rows.map((row) => ({
    ...row,
    tags: [...new Set(adsets.filter((a) => keyOf(a) === row.id && a.tag).map((a) => a.tag))].slice(0, 40),
  }));
}

/**
 * Ads under a set of ad sets. Linkage is by parentId when the row carries it
 * (MCP upgrade, Sept 2026 — exact), falling back to parent NAME for older
 * snapshots (duplicate ad-set names can over-match there). Each ad inherits
 * its parent's source tag so the lead drill works at ad level too — the
 * cohort is the parent ad set's, which the drawer says.
 */
function adsUnder(block, adsets) {
  const byId = new Map(adsets.map((a) => [a.id, a]));
  const byName = new Map(adsets.map((a) => [a.name, a]));
  const out = [];
  for (const x of block.levels.ad) {
    const parent = x.parentId ? byId.get(x.parentId) : byName.get(x.parentName);
    if (!parent) continue;
    out.push(x.tag ? x : { ...x, tag: parent.tag || null, _parentSet: parent.name });
  }
  return out;
}

/** Levels recomputed under the current breadcrumb path. */
function effectiveLevels(block) {
  if (!state.path.length) return { ...block.levels, ad: adsUnder(block, block.levels.adset) };

  let adsets = block.levels.adset;
  for (const crumb of state.path) {
    const filter = CRUMB_FILTER[crumb.level];
    if (filter) adsets = adsets.filter((a) => filter(a, crumb.id));
  }
  const ads = adsUnder(block, adsets);

  const accountName = new Map(state.snapshot.adAccounts.map((a) => [String(a.id), a.name]));
  return {
    traffic:  withTags(rollup(adsets, (r) => r._traffic, (id) => id), adsets, (a) => a._traffic),
    account:  withTags(rollup(adsets, (r) => r._account, (id) => accountName.get(id) || id || 'Unknown'), adsets, (a) => a._account),
    campaign: withTags(rollup(adsets, (r) => r._category, (id) => id), adsets, (a) => a._category),
    adset:    adsets,
    ad:       ads,
  };
}

function descend(row) {
  const child = CHILD_LEVEL[state.level];
  if (!child) return;
  state.path.push({ level: state.level, id: row.id, name: row.name || row.id });
  state.level = child;
  renderLevelChips();
  renderReport();
}

function renderCrumbs() {
  const el = $('crumbs');
  if (!state.path.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `
    <button class="crumb" data-i="-1">All</button>
    ${state.path.map((c, i) => `
      <span class="crumb-sep">›</span>
      <button class="crumb ${i === state.path.length - 1 ? 'current' : ''}" data-i="${i}"
              title="${esc(LEVEL_LABEL[c.level])}">${esc(c.name)}</button>`).join('')}
    <button class="crumb clear" data-i="clear" title="Clear drill-down">✕</button>`;
  el.querySelectorAll('.crumb').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = btn.dataset.i;
      if (i === 'clear' || i === '-1') {
        state.path = [];
      } else {
        const idx = Number(i);
        state.path = state.path.slice(0, idx + 1);
        state.level = CHILD_LEVEL[state.path[idx].level] || state.level;
      }
      renderLevelChips();
      renderReport();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function renderRangeChips() {
  const ranges = state.snapshot.ranges || {};
  const title = (r) => (r.skipped ? `Not fetched this refresh (${r.skipped}) — press Refresh again`

    : `${r.start} → ${r.end}`);
  $('rangeChips').innerHTML = Object.entries(ranges).map(([key, r]) => `
    <button class="chip ${key === state.range ? 'active' : ''}"
            data-range="${key}" ${r.skipped ? 'disabled' : ''}
            title="${esc(title(r))}">
      ${esc(r.label)}
    </button>`).join('');

  $('rangeChips').querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { state.range = c.dataset.range; renderRangeChips(); renderReport(); }));
}

function renderLevelChips() {
  $('levelChips').innerHTML = LEVELS.map((l) => `
    <button class="chip ${l.key === state.level ? 'active' : ''}" data-level="${l.key}">${l.label}</button>`).join('');
  $('levelChips').querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { state.level = c.dataset.level; renderLevelChips(); renderReport(); }));
}

$('reportSearch').addEventListener('input', (e) => { state.search = e.target.value.toLowerCase(); renderReport(); });
$('hideZero').addEventListener('change', (e) => { state.hideZero = e.target.checked; renderReport(); });

function currentRows() {
  const block = state.snapshot.ranges?.[state.range];
  if (!block || block.skipped) return null;
  let rows = effectiveLevels(block)[state.level] || [];
  if (state.search) rows = rows.filter((r) =>
    `${r.name ?? ''} ${r.parentName ?? ''} ${r.id}`.toLowerCase().includes(state.search));
  if (state.hideZero) rows = rows.filter((r) => (r.cost || 0) > 0 || (r.revenue || 0) > 0);

  const { col, dir } = state.sort;
  return [...rows].sort((a, b) => {
    const av = a[col], bv = b[col];
    if (typeof av === 'string' || typeof bv === 'string') {
      return dir === 'asc'
        ? String(av ?? '').localeCompare(String(bv ?? ''))
        : String(bv ?? '').localeCompare(String(av ?? ''));
    }
    const an = Number.isFinite(av) ? av : -Infinity;
    const bn = Number.isFinite(bv) ? bv : -Infinity;
    return dir === 'asc' ? an - bn : bn - an;
  });
}

function toneClass(col, value) {
  if (!col.tone || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? 'good' : 'bad';
}

function rowDrillTags(row) {
  if (row.tag) return [row.tag];
  if (Array.isArray(row.tags) && row.tags.length) return row.tags;
  return null;
}

function renderReport() {
  renderCrumbs();
  const block = state.snapshot.ranges?.[state.range];
  const rows = currentRows();

  if (!rows) {
    $('reportKpis').innerHTML = '';
    $('reportTable').innerHTML = `<tbody><tr><td class="empty">${block?.skipped
      ? `This range was not fetched this refresh (${esc(block.skipped)}).<br>Press <b>Refresh</b> again — the refresh is incremental.`
      : state.origin === 'none'
        ? 'The first snapshot has not been built yet.'
        : 'No data for this range yet — press <b>Refresh</b>.'}</td></tr></tbody>`;
    $('reportCount').textContent = '';
    updateHProxy();
    return;
  }

  const cols = activeCols();
  const totals = aggregate(rows);
  const canDescend = Boolean(CHILD_LEVEL[state.level]);

  const fmtDay = (d) => {
    const t = new Date(`${d}T00:00:00`);
    return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const rangeLabel = block.start === block.end
    ? fmtDay(block.start) : `${fmtDay(block.start)} – ${fmtDay(block.end)}`;
  $('reportKpis').innerHTML = `<div class="kpi-range">${esc(rangeLabel)}</div>` + KPIS.map((k) => {
    const v = totals[k.key];
    return `<div class="kpi${k.key === KPI_HY ? ' hy' : ''}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value ${toneClass(k, v)}">${formatCell(v, k.type)}</div>
    </div>`;
  }).join('');

  const headCols = [{ k: 'name', l: 'Name', t: 'text' }, ...cols];
  const head = headCols.map((c) => {
    const sorted = state.sort.col === c.k;
    const arrow = sorted ? (state.sort.dir === 'asc' ? '▲' : '▼') : '';
    return `<th class="${sorted ? 'sorted' : ''}${HY.has(c.k) ? ' hy' : ''}" data-col="${c.k}"
      title="${c.k === 'name' ? '' : 'Drag to reorder · click to sort'}">${c.l}<span class="arrow">${arrow}</span></th>`;
  }).join('');

  const body = rows.map((r, i) => `<tr data-i="${i}">${headCols.map((c) => {
    if (c.k === 'name') {
      const sub = r.parentName ? `<span class="sub">${esc(r.parentName)}</span>`
        : r.children ? `<span class="pill">${r.children}</span>` : '';
      const label = esc(r.name || r.id);
      return `<td><div class="name-cell">${canDescend
        ? `<button class="name-drill" data-i="${i}" title="Drill into ${esc(LEVEL_LABEL[CHILD_LEVEL[state.level]])}s">${label}</button>`
        : `<span>${label}</span>`}${sub}</div></td>`;
    }
    const v = r[c.k];
    const metric = DRILL_METRIC[c.k];
    const drillable = metric && Number.isFinite(v) && v > 0 && rowDrillTags(r);
    const text = formatCell(v, c.t);
    return `<td class="${toneClass(c, v)}${HY.has(c.k) ? ' hy' : ''}">${drillable
      ? `<button class="drill" data-i="${i}" data-metric="${metric}" data-label="${esc(c.l)}">${text}</button>`
      : text}</td>`;
  }).join('')}</tr>`).join('');

  const foot = `<tr>${headCols.map((c) => {
    if (c.k === 'name') return `<td>Total · ${rows.length} rows</td>`;
    const v = totals[c.k];
    return `<td class="${toneClass(c, v)}${HY.has(c.k) ? ' hy' : ''}">${formatCell(v, c.t)}</td>`;
  }).join('')}</tr>`;

  $('reportTable').innerHTML = rows.length
    ? `<thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot>`
    : `<tbody><tr><td class="empty">No rows match this filter.</td></tr></tbody>`;

  $('reportCount').textContent = `${rows.length} rows`;

  $('reportTable').querySelectorAll('thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      state.sort = state.sort.col === col
        ? { col, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { col, dir: col === 'name' ? 'asc' : 'desc' };
      renderReport();
    });
    wireHeaderDrag(th);
  });

  $('reportTable').querySelectorAll('button.name-drill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      descend(rows[Number(btn.dataset.i)]);
    });
  });

  $('reportTable').querySelectorAll('button.drill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrill(rows[Number(btn.dataset.i)], btn.dataset.metric, btn.dataset.label);
    });
  });

  updateHProxy();
}

/* ------------------------------------------------------------------ *
 * Sticky horizontal scrollbar proxy — always reachable at the bottom
 * of the viewport, synced both ways with the visible table wrap.
 * ------------------------------------------------------------------ */

let hTarget = null;

function visibleWrap() {
  return $('view-crm').hidden
    ? $('reportTable').closest('.table-wrap')
    : $('crmTable').closest('.table-wrap');
}

function updateHProxy() {
  const proxy = $('hproxy');
  const inner = $('hproxyInner');
  const wrap = visibleWrap();
  if (hTarget !== wrap) {
    hTarget = wrap;
    if (wrap) wrap.addEventListener('scroll', () => {
      if (Math.abs(proxy.scrollLeft - wrap.scrollLeft) > 1) proxy.scrollLeft = wrap.scrollLeft;
    });
  }
  if (!wrap || wrap.scrollWidth <= wrap.clientWidth + 4) { proxy.hidden = true; return; }
  const rect = wrap.getBoundingClientRect();
  proxy.hidden = false;
  proxy.style.left = `${rect.left}px`;
  proxy.style.width = `${rect.width}px`;
  inner.style.width = `${wrap.scrollWidth}px`;
  proxy.scrollLeft = wrap.scrollLeft;
}

function initHProxy() {
  const proxy = $('hproxy');
  proxy.addEventListener('scroll', () => {
    if (hTarget && Math.abs(hTarget.scrollLeft - proxy.scrollLeft) > 1) {
      hTarget.scrollLeft = proxy.scrollLeft;
    }
  });
  window.addEventListener('resize', updateHProxy);
  updateHProxy();
}

/* ------------------------------------------------------------------ *
 * Drill drawer — number -> cohort/records -> journey
 * ------------------------------------------------------------------ */

function openDrawer(title, sub) {
  $('drawerTitle').textContent = title;
  $('drawerSub').innerHTML = sub || '';
  $('drawerBody').innerHTML = '<div class="empty"><img class="sven-load" src="/assets/brand/sven-lavender.svg" alt="">Loading…</div>';
  $('drawer').hidden = false;
  $('drawerScrim').hidden = false;
  $('drawerBack').hidden = true;
  document.body.classList.add('drawer-open');
}

function closeDrawer() {
  $('drawer').hidden = true;
  $('drawerScrim').hidden = true;
  document.body.classList.remove('drawer-open');
}
$('drawerClose').addEventListener('click', closeDrawer);
$('drawerScrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

let drillContext = null;

async function openDrill(row, metric, label) {
  const tags = rowDrillTags(row);
  drillContext = { row, metric, label };
  openDrawer(row.name || row.id, `${esc(label)} · loading`);

  if (state.demo) {
    // Demo drills are generated locally — the API (and real customer data)
    // is never touched while demo mode is on.
    const body = metric === 'leads' ? demoCohort(row) : demoRecords(row, metric);
    if (body.kind === 'leads') renderCohort(body); else renderRecords(body, label);
    return;
  }

  try {
    const { body } = await api(
      `/api/drill?metric=${metric}&tags=${encodeURIComponent(tags.join(','))}`);
    if (!body.ok) {
      $('drawerBody').innerHTML = `<div class="note" style="margin:16px">${esc(body.message || body.error)}</div>`;
      $('drawerSub').textContent = label;
      return;
    }
    if (body.kind === 'leads') renderCohort(body);
    else renderRecords(body, label);
  } catch (err) {
    $('drawerBody').innerHTML = `<div class="note err" style="margin:16px">${esc(err.message)}</div>`;
  }
}

const touchPill = `<span class="pill" title="Cohort from get_leads({tags}) — leads that CLICKED this source. Attribution models can credit some conversions to a different source, so this can differ from the table cell.">touched ≠ credited</span>`;
const demoPill = (origin) => (origin === 'seed' ? ' <span class="pill warn">demo data</span>'
  : origin === 'demo' ? ' <span class="pill warn">demo</span>' : '');

const adSetNote = () => (drillContext?.row?._parentSet
  ? ` <span class="pill" title="Leads are tagged per ad set, not per ad — this is the cohort of the ad set this ad runs in.">ad set cohort: ${esc(drillContext.row._parentSet)}</span>` : '');

function renderCohort(body) {
  const leads = body.leads || [];
  $('drawerSub').innerHTML =
    `${leads.length}${body.truncated ? '+' : ''} leads <b>touched</b> this source ${touchPill}${adSetNote()}${demoPill(body.origin)}`;

  if (!leads.length) {
    $('drawerBody').innerHTML = '<div class="empty">No leads returned for this source.</div>';
    return;
  }

  $('drawerBody').innerHTML = `<div class="cohort">${leads.map((l, i) => `
    <button class="cohort-row" data-email="${esc(l.email)}">
      <div class="cohort-main">
        <span class="cohort-email">${esc(l.email)}</span>
        ${l.stage ? `<span class="pill stage">${esc(l.stage)}</span>` : ''}
      </div>
      <div class="cohort-sub">
        ${esc(fmt.date(l.joined))}
        ${l.firstSource?.ad ? ` · ad: ${esc(l.firstSource.ad)}` : ''}
        ${l.lastSource && l.lastSource.tag !== l.firstSource?.tag
          ? ` · last: ${esc(l.lastSource.name)}${l.lastSource.organic ? ' (organic)' : ''}` : ''}
      </div>
    </button>`).join('')}</div>`;

  wireDrawerRows();
}

function renderRecords(body, label) {
  const records = body.records || [];
  const isSales = body.kind === 'sales';
  const inAccount = (r) => !r.currency || r.currency === fmt.currency;
  const total = isSales ? records.filter(inAccount).reduce((s, r) => s + (r.amount || 0), 0) : null;
  const foreign = isSales ? records.filter((r) => !inAccount(r)).length : 0;

  $('drawerSub').innerHTML =
    `${records.length} ${esc(body.kind)} from ${body.cohortSize}${body.truncated ? '+' : ''} touched leads`
    + (isSales && total ? ` · <b class="good">${fmt.money(total)}</b>` : '')
    + (foreign ? ` · ${fmt.int(foreign)} sale${foreign === 1 ? '' : 's'} in other currencies not summed` : '')
    + ` ${touchPill}${adSetNote()}${demoPill(body.origin)}`;

  if (!records.length) {
    $('drawerBody').innerHTML = `<div class="empty">No ${esc(body.kind)} recorded for this cohort in the window.</div>`;
    return;
  }

  $('drawerBody').innerHTML = `<div class="cohort">${records.map((r) => `
    <button class="cohort-row" data-email="${esc(r.email)}">
      <div class="cohort-main">
        <span class="cohort-email">${esc(r.email)}</span>
        ${isSales && r.amount ? `<span class="tl-extra">${fmt.moneyIn(r.amount, r.currency)}</span>` : ''}
        ${r.state ? `<span class="pill ${r.state === 'QUALIFIED' ? 'stage' : r.state === 'REFUNDED' ? 'warn' : ''}">${esc(r.state)}</span>` : ''}
      </div>
      <div class="cohort-sub">
        ${esc(fmt.datetime(r.date))}${r.name ? ` · ${esc(r.name)}` : ''}${r.source ? ` · src: ${esc(r.source)}` : ''}
      </div>
    </button>`).join('')}</div>`;

  wireDrawerRows();
}

function wireDrawerRows() {
  $('drawerBody').querySelectorAll('.cohort-row').forEach((el) => {
    el.addEventListener('click', () => openJourney(el.dataset.email));
  });
}

async function openJourney(email, standalone = false) {
  if (standalone) {
    drillContext = null;
    openDrawer(email, 'Lead journey');
  } else {
    $('drawerTitle').textContent = email;
    $('drawerSub').textContent = 'Lead journey';
    $('drawerBody').innerHTML = '<div class="empty"><img class="sven-load" src="/assets/brand/sven-lavender.svg" alt="">Loading…</div>';
  }
  $('drawerBack').hidden = !drillContext;

  if (state.demo) {
    renderJourney(demoJourney(email).journey, 'demo');
    return;
  }

  try {
    const { body } = await api(`/api/drill?email=${encodeURIComponent(email)}`);
    if (!body.ok) {
      $('drawerBody').innerHTML = `<div class="note" style="margin:16px">${esc(body.message || body.error)}</div>`;
      return;
    }
    renderJourney(body.journey, body.origin);
  } catch (err) {
    $('drawerBody').innerHTML = `<div class="note err" style="margin:16px">${esc(err.message)}</div>`;
  }
}

const JOURNEY_ICONS = {
  sale: '💰', call: '📞', 'lead-stage': '🏁', 'opt-in': '✉️', sl: '🖱️', action: '⚡',
};

function renderJourney(j, origin) {
  const income = (j.sales || []).reduce((s, x) => s + (x.amount || 0), 0);
  const l = j.lead || {};

  $('drawerSub').innerHTML =
    `${l.stage ? `<span class="pill stage">${esc(l.stage)}</span> ` : ''}`
    + `joined ${esc(fmt.date(l.joined))}`
    + (income ? ` · <b class="good">${fmt.money(income)}</b>` : '')
    + demoPill(origin);

  const timeline = (j.journey || []).map((e) => `
    <div class="tl-item tl-${esc(e.type)}">
      <div class="tl-icon">${JOURNEY_ICONS[e.type] || '•'}</div>
      <div class="tl-body">
        <div class="tl-head">
          <b>${esc(e.keyword)}</b> ${esc(e.name)}
          ${e.extra ? `<span class="tl-extra">${esc(e.extra)}</span>` : ''}
        </div>
        ${e.subNames?.length ? `<div class="tl-sub">${esc(e.subNames.join(', '))}</div>` : ''}
        <div class="tl-date">${esc(fmt.datetime(e.date))}</div>
      </div>
    </div>`).join('');

  const clicksNote = j.clicksError && !(j.clicks || []).length
    ? `<div class="drawer-section">Click history</div><div class="sub">Click history could not be fetched: ${esc(j.clicksError)}</div>`
    : '';
  const clicks = (j.clicks || []).length ? `
    <div class="drawer-section">Click history · ${j.clicks.length} tracked clicks</div>
    <div class="clicks">${j.clicks.map((c) => `
      <div class="click-row">
        <div class="click-page">${esc((c.page || '').replace(/^https?:\/\//, ''))}
          ${c.source ? `<span class="pill">${esc(c.source)}</span>` : ''}
          ${c.platform ? `<span class="pill fb">${esc(c.platform)}</span>` : ''}
        </div>
        <div class="click-sub">
          ${c.previousUrl ? `from ${esc(c.previousUrl.replace(/^https?:\/\//, ''))} · ` : ''}${esc(fmt.datetime(c.date))}
        </div>
      </div>`).join('')}</div>` : '';

  $('drawerBody').innerHTML = `
    <div class="drawer-section">Journey</div>
    <div class="timeline">${timeline || '<div class="empty">No journey events.</div>'}</div>
    ${clicksNote}${clicks}`;
}

$('drawerBack').addEventListener('click', () => {
  if (!drillContext) return closeDrawer();
  openDrill(drillContext.row, drillContext.metric, drillContext.label);
});

/* ------------------------------------------------------------------ *
 * CRM
 * ------------------------------------------------------------------ */

const CRM_TABS = [
  { key: 'leads', label: 'Leads' },
  { key: 'sales', label: 'Sales' },
  { key: 'calls', label: 'Calls' },
  { key: 'subscriptions', label: 'Subscriptions' },
];

const CRM_COLUMNS = [
  { key: 'joined',         label: 'Joined on',        txt: true },
  { key: 'email',          label: 'Lead',             txt: true },
  { key: 'name',           label: 'Name',             txt: true },
  { key: 'firstSourceName',label: 'First Source',     txt: true },
  { key: 'lastSourceName', label: 'Last Source',      txt: true },
  { key: 'lastSourceDate', label: 'Last Source Date', txt: true },
  { key: 'income',         label: 'Income', money: true },
  { key: 'stage',          label: 'Stage',            txt: true },
  { key: 'consent',        label: 'Ad O.C.',          txt: true },
  { key: 'tagList',        label: 'Tags',             txt: true },
];

function sortRows(rows, sort) {
  return rows.sort((a, b) => {
    const av = a[sort.col], bv = b[sort.col];
    if (typeof av === 'number' || typeof bv === 'number') {
      return sort.dir === 'asc' ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0);
    }
    return sort.dir === 'asc'
      ? String(av ?? '').localeCompare(String(bv ?? ''))
      : String(bv ?? '').localeCompare(String(av ?? ''));
  });
}

function crmRows() {
  const leads = (state.snapshot.crm?.leads || []).map((l) => ({
    ...l,
    firstSourceName: l.firstSource?.name || null,
    lastSourceName: l.lastSource?.name || null,
    tagList: (l.tags || []).join(' '),
  }));

  const { stage, attr, search, sort } = state.crm;
  let rows = leads;
  if (stage) rows = rows.filter((l) => l.stage === stage);
  if (attr === 'yes') rows = rows.filter((l) => l.hasAttribution);
  if (attr === 'no') rows = rows.filter((l) => !l.hasAttribution);
  if (search) rows = rows.filter((l) =>
    `${l.email} ${l.name ?? ''} ${l.firstSourceName ?? ''} ${l.tagList}`.toLowerCase().includes(search));
  return sortRows(rows, sort);
}

function recordRows(kind) {
  const rows = state.snapshot.crm?.[kind];
  if (!Array.isArray(rows)) return null; // old snapshot — needs a Refresh
  const { search, sort } = state.crm;
  let out = rows;
  if (search) out = out.filter((r) =>
    `${r.email} ${r.leadName ?? ''} ${r.product ?? ''} ${r.name ?? ''} ${r.firstSource ?? ''} ${r.lastSource ?? ''}`
      .toLowerCase().includes(search));
  const col = sort.col === 'joined' ? 'date' : sort.col;
  return sortRows([...out], { ...sort, col });
}

function renderCrmTabs() {
  const crm = state.snapshot.crm || {};
  const count = (kind) => (Array.isArray(crm[kind]) ? `${fmt.int(crm[kind].length)}${crmTruncated(kind) ? '+' : ''}` : '?');
  const counts = {
    leads: count('leads'),
    sales: count('sales'),
    calls: count('calls'),
    subscriptions: count('subscriptions'),
  };
  renderCrmNote();
  $('crmTabs').innerHTML = CRM_TABS.map((t) => `
    <button class="chip ${state.crm.tab === t.key ? 'active' : ''}" data-tab="${t.key}">
      ${t.label} <span class="chip-count">${counts[t.key]}</span>
    </button>`).join('');
  $('crmTabs').querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { state.crm.tab = c.dataset.tab; renderCrm(); }));

  const leadsOnly = state.crm.tab === 'leads';
  $('stageFilter').hidden = !leadsOnly;
  $('attrFilter').hidden = !leadsOnly;
}

/**
 * KPI tiles. Every field is TEXT and is escaped here — features hand in raw
 * names (an ad name as `sub`, say), so this is the one place that makes them
 * safe. `cls` is limited to the two money tones.
 */
function kpiTiles(list) {
  const tone = (cls) => (cls === 'good' || cls === 'bad' ? cls : '');
  return list.map((k) => `<div class="kpi"${k.title ? ` title="${esc(k.title)}"` : ''}>
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-value ${tone(k.cls)}">${esc(k.value)}</div>
      <div class="kpi-sub">${esc(k.sub || '')}</div>
    </div>`).join('');
}

/* ---------- CRM list caps (crm.sync.truncated.<kind>) and carry-over (crm.sync.stale) ---------- */

/** True when the MCP had more <kind> rows than the refresh fetched (the list is capped). */
const crmTruncated = (kind) => Boolean(state.snapshot?.crm?.sync?.truncated?.[kind]);
const crmTotal = (kind) => (Array.isArray(state.snapshot?.crm?.[kind]) ? state.snapshot.crm[kind].length : 0);

/** "1,000+ leads (newest 1,000 shown)" on a capped list; "12 of 1,000+ leads (…)" once filtered. */
function crmCountText(kind, shown) {
  if (!crmTruncated(kind)) return `${fmt.int(shown)} ${kind}`;
  const cap = fmt.int(crmTotal(kind));
  return `${shown === crmTotal(kind) ? '' : `${fmt.int(shown)} of `}${cap}+ ${kind} (newest ${cap} shown)`;
}

/** Tooltip for a KPI that sums over a capped list; empty when the list is complete. */
function capTitle(...kinds) {
  const capped = kinds.filter(crmTruncated);
  if (!capped.length) return '';
  return `based on the first ${capped.map((k) => `${fmt.int(crmTotal(k))} ${k}`).join(' and ')} rows — the list was capped`;
}

/** The CRM note: carried-over CRM and capped lists, said once above the table. */
function renderCrmNote() {
  const sync = state.snapshot?.crm?.sync || {};
  const bits = [];
  if (sync.stale) {
    bits.push('<b>CRM from the previous refresh.</b> The last refresh ran out of time before the CRM, '
      + 'so these leads, sales, calls and subscriptions are the previous snapshot’s.');
  }
  const capped = CRM_TABS.filter((t) => sync.truncated?.[t.key])
    .map((t) => `${t.label.toLowerCase()} (newest ${fmt.int(crmTotal(t.key))} shown)`);
  if (capped.length) {
    bits.push(`<b>Capped lists:</b> ${esc(capped.join(', '))} — HYROS had more rows than this refresh fetched, `
      + 'so the totals on those tabs cover only the rows shown.');
  }
  $('crmNote').innerHTML = bits.length ? `<div class="note">${bits.join(' ')}</div>` : '';
}

function attachCrmSort() {
  $('crmTable').querySelectorAll('thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      state.crm.sort = state.crm.sort.col === col
        ? { col, dir: state.crm.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { col, dir: 'desc' };
      renderCrm();
    });
  });
  $('crmTable').querySelectorAll('button.drill[data-email]').forEach((btn) => {
    btn.addEventListener('click', () => openJourney(btn.dataset.email, true));
  });
  updateHProxy();
}

function headRow(cols) {
  return `<thead><tr>${cols.map((c) => {
    const sorted = state.crm.sort.col === c.key;
    const arrow = sorted ? (state.crm.sort.dir === 'asc' ? '▲' : '▼') : '';
    return `<th class="${sorted ? 'sorted' : ''} ${c.txt ? 'txt' : ''}" data-col="${c.key}">${c.label}<span class="arrow">${arrow}</span></th>`;
  }).join('')}</tr></thead>`;
}

const emailCell = (email) =>
  `<td class="txt"><button class="drill clip clip-l" title="${esc(email)}" data-email="${esc(email)}">${esc(email)}</button></td>`;
const dash = '<span class="sub">—</span>';
const clip = (text, size = 'm', extra = '') => (text
  ? `<span class="clip clip-${size}" title="${esc(text)}">${esc(text)}${extra}</span>`
  : dash);

function renderCrm() {
  renderCrmTabs();
  const tab = state.crm.tab;
  if (tab === 'leads') return renderCrmLeads();
  if (tab === 'sales') return renderCrmSales();
  if (tab === 'calls') return renderCrmCalls();
  return renderCrmSubs();
}

function needsRefresh(label) {
  $('crmKpis').innerHTML = '';
  $('crmTable').innerHTML = `<tbody><tr><td class="empty">${label} aren’t in the current snapshot —
    it was built before this feature shipped.<br>Hit <b>Refresh</b> to pull them from the MCP.</td></tr></tbody>`;
  $('crmCount').textContent = '';
  updateHProxy();
}

function renderCrmLeads() {
  const crm = state.snapshot.crm || { leads: [], stages: [], totals: {} };
  const sel = $('stageFilter');
  if (sel.options.length <= 1) {
    for (const st of crm.stages || []) {
      const o = document.createElement('option');
      o.value = st.name;
      o.textContent = `${st.name} (${st.amount})`;
      sel.appendChild(o);
    }
  }

  const rows = crmRows();
  const income = rows.reduce((s, l) => s + (l.income || 0), 0);
  const attributed = rows.filter((l) => l.hasAttribution).length;

  const cap = capTitle('leads');
  $('crmKpis').innerHTML = kpiTiles([
    { label: 'Leads in view', value: fmt.int(rows.length), title: cap },
    { label: 'Attributed', value: fmt.int(attributed), title: cap,
      sub: rows.length ? `${((attributed / rows.length) * 100).toFixed(0)}% have a click source` : '' },
    { label: 'Customers', value: fmt.int(rows.filter((l) => l.stage === 'Customer').length), title: cap },
    { label: 'Income', value: fmt.money(income), sub: 'joined from sales by email', title: capTitle('leads', 'sales') },
    { label: 'Account total', value: fmt.int((crm.stages || []).reduce((s, x) => s + x.amount, 0)),
      sub: 'leads across all stages' },
  ]);

  const body = rows.map((l) => `<tr>
    <td class="txt">${esc(fmt.date(l.joined))}</td>
    ${emailCell(l.email)}
    <td class="txt">${clip(l.name, 'm')}</td>
    <td class="txt">${clip(l.firstSourceName, 's',
        l.firstSource?.organic ? ' <span class="pill">org</span>' : '')}</td>
    <td class="txt">${clip(l.lastSourceName, 's')}</td>
    <td class="txt">${esc(fmt.date(l.lastSourceDate))}</td>
    <td>${l.income ? fmt.money(l.income) : dash}</td>
    <td class="txt">${l.stage ? `<span class="pill stage">${esc(l.stage)}</span>` : dash}</td>
    <td class="txt">${esc(l.consent === 'UNSPECIFIED' ? '—' : l.consent)}</td>
    <td class="txt">${clip((l.tags || []).join(', '), 'l')}</td>
  </tr>`).join('');

  $('crmTable').innerHTML = rows.length
    ? `${headRow(CRM_COLUMNS)}<tbody>${body}</tbody>`
    : `<tbody><tr><td class="empty">No leads match this filter.</td></tr></tbody>`;
  $('crmCount').textContent = crmCountText('leads', rows.length);
  attachCrmSort();
}

const SALES_COLUMNS = [
  { key: 'date',        label: 'Date',          txt: true },
  { key: 'email',       label: 'Lead',          txt: true },
  { key: 'leadName',    label: 'Name',          txt: true },
  { key: 'product',     label: 'Product',       txt: true },
  { key: 'amount',      label: 'Amount', money: true },
  { key: 'currency',    label: 'Currency',      txt: true },
  { key: 'firstSource', label: 'Origin Source', txt: true },
  { key: 'lastSource',  label: 'Last Source',   txt: true },
  { key: 'recurring',   label: 'Recurring',     txt: true },
  { key: 'refunded',    label: 'Refunded',      txt: true },
];

function renderCrmSales() {
  const rows = recordRows('sales');
  if (rows === null) return needsRefresh('Sales');

  // Totals only make sense in one currency: sum the account's, count the rest.
  const inAccount = (x) => !x.currency || x.currency === fmt.currency;
  const revenue = rows.filter(inAccount).reduce((s, x) => s + (x.amount || 0), 0);
  const foreign = rows.filter((x) => !inAccount(x)).length;
  const fx = foreign ? `${fmt.int(foreign)} sale${foreign === 1 ? '' : 's'} in other currencies not summed` : '';
  const cap = capTitle('sales');
  $('crmKpis').innerHTML = kpiTiles([
    { label: 'Sales in view', value: fmt.int(rows.length), title: cap },
    { label: 'Revenue', value: fmt.money(revenue), cls: revenue ? 'good' : '', sub: fx, title: cap },
    { label: 'AOV', value: fmt.money(rows.length - foreign ? revenue / (rows.length - foreign) : null), sub: fx, title: cap },
    { label: 'Refunded', value: fmt.int(rows.filter((x) => x.refunded).length), title: cap },
    { label: 'Recurring', value: fmt.int(rows.filter((x) => x.recurring).length), title: cap },
  ]);

  const body = rows.map((x) => `<tr>
    <td class="txt">${esc(fmt.datetime(x.date))}</td>
    ${emailCell(x.email)}
    <td class="txt">${clip(x.leadName, 'm')}</td>
    <td class="txt">${clip(x.product, 's')}</td>
    <td class="good">${fmt.moneyIn(x.amount, x.currency)}</td>
    <td class="txt">${esc(x.currency || fmt.currency)}</td>
    <td class="txt">${clip(x.firstSource, 's')}</td>
    <td class="txt">${clip(x.lastSource, 's')}</td>
    <td class="txt">${x.recurring ? 'Yes' : dash}</td>
    <td class="txt">${x.refunded ? '<span class="pill warn">refunded</span>' : dash}</td>
  </tr>`).join('');

  $('crmTable').innerHTML = rows.length
    ? `${headRow(SALES_COLUMNS)}<tbody>${body}</tbody>`
    : `<tbody><tr><td class="empty">No sales in this snapshot window.</td></tr></tbody>`;
  $('crmCount').textContent = crmCountText('sales', rows.length);
  attachCrmSort();
}

const CALLS_COLUMNS = [
  { key: 'date',        label: 'Date',          txt: true },
  { key: 'email',       label: 'Lead',          txt: true },
  { key: 'leadName',    label: 'Name',          txt: true },
  { key: 'name',        label: 'Call',          txt: true },
  { key: 'state',       label: 'State',         txt: true },
  { key: 'firstSource', label: 'Origin Source', txt: true },
  { key: 'ad',          label: 'Ad',            txt: true },
  { key: 'lastSource',  label: 'Last Source',   txt: true },
];

function renderCrmCalls() {
  const rows = recordRows('calls');
  if (rows === null) return needsRefresh('Calls');

  const qualified = rows.filter((x) => x.qualified).length;
  const attributed = rows.filter((x) => x.firstSource || x.lastSource).length;
  const cap = capTitle('calls');
  $('crmKpis').innerHTML = kpiTiles([
    { label: 'Calls in view', value: fmt.int(rows.length), title: cap },
    { label: 'Qualified', value: fmt.int(qualified), title: cap,
      sub: rows.length ? `${((qualified / rows.length) * 100).toFixed(0)}% of calls` : '' },
    { label: 'Attributed', value: fmt.int(attributed), sub: 'call carries a click source', title: cap },
    { label: 'From ads', value: fmt.int(rows.filter((x) => x.ad).length), sub: 'specific ad known', title: cap },
  ]);

  const stateCls = (st) => (st === 'QUALIFIED' ? 'stage' : st === 'NO_SHOW' || st === 'CANCELLED' ? 'warn' : '');
  const body = rows.map((x) => `<tr>
    <td class="txt">${esc(fmt.datetime(x.date))}</td>
    ${emailCell(x.email)}
    <td class="txt">${clip(x.leadName, 'm')}</td>
    <td class="txt">${clip(x.name, 's')}</td>
    <td class="txt">${x.state ? `<span class="pill ${stateCls(x.state)}">${esc(x.state)}</span>` : dash}</td>
    <td class="txt">${clip(x.firstSource, 's')}</td>
    <td class="txt">${clip(x.ad, 's')}</td>
    <td class="txt">${clip(x.lastSource, 's')}</td>
  </tr>`).join('');

  $('crmTable').innerHTML = rows.length
    ? `${headRow(CALLS_COLUMNS)}<tbody>${body}</tbody>`
    : `<tbody><tr><td class="empty">No booked calls in this snapshot window.</td></tr></tbody>`;
  $('crmCount').textContent = crmCountText('calls', rows.length);
  attachCrmSort();
}

const SUBS_COLUMNS = [
  { key: 'date',        label: 'Start',    txt: true },
  { key: 'email',       label: 'Lead',     txt: true },
  { key: 'name',        label: 'Name',     txt: true },
  { key: 'price',       label: 'Price', money: true },
  { key: 'currency',    label: 'Currency', txt: true },
  { key: 'periodicity', label: 'Period',   txt: true },
  { key: 'status',      label: 'Status',   txt: true },
  { key: 'provider',    label: 'Provider', txt: true },
];

function renderCrmSubs() {
  const rows = recordRows('subscriptions');
  if (rows === null) return needsRefresh('Subscriptions');

  const active = rows.filter((x) => x.status === 'ACTIVE' || x.status === 'TRIALING');
  const cap = capTitle('subscriptions');
  $('crmKpis').innerHTML = kpiTiles([
    { label: 'Subscriptions', value: fmt.int(rows.length), title: cap },
    { label: 'Active / trialing', value: fmt.int(active.length), title: cap },
    { label: 'Canceled', value: fmt.int(rows.filter((x) => x.status === 'CANCELED').length), title: cap },
    { label: 'Active value', value: fmt.money(active.filter((x) => !x.currency || x.currency === fmt.currency).reduce((s, x) => s + (x.price || 0), 0)),
      sub: `sum of active plan prices${active.some((x) => x.currency && x.currency !== fmt.currency) ? ' (account currency only)' : ''}`, title: cap },
  ]);

  const body = rows.map((x) => `<tr>
    <td class="txt">${esc(fmt.date(x.date))}</td>
    ${emailCell(x.email)}
    <td class="txt">${clip(x.name, 'm')}</td>
    <td>${fmt.moneyIn(x.price, x.currency)}</td>
    <td class="txt">${esc(x.currency || fmt.currency)}</td>
    <td class="txt">${esc(x.periodicity || '—')}</td>
    <td class="txt">${x.status ? `<span class="pill ${x.status === 'ACTIVE' ? 'stage' : ''}">${esc(x.status)}</span>` : dash}</td>
    <td class="txt">${esc(x.provider || '—')}</td>
  </tr>`).join('');

  $('crmTable').innerHTML = rows.length
    ? `${headRow(SUBS_COLUMNS)}<tbody>${body}</tbody>`
    : `<tbody><tr><td class="empty">No subscriptions tracked in this account’s snapshot window —
       the tab is wired to <code>hyros_get_subscriptions</code> and will populate when they exist.</td></tr></tbody>`;
  $('crmCount').textContent = crmCountText('subscriptions', rows.length);
  attachCrmSort();
}

$('stageFilter').addEventListener('change', (e) => { state.crm.stage = e.target.value; renderCrm(); });
$('attrFilter').addEventListener('change', (e) => { state.crm.attr = e.target.value; renderCrm(); });
$('crmSearch').addEventListener('input', (e) => { state.crm.search = e.target.value.toLowerCase(); renderCrm(); });

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/* A text cell starting with one of these is a formula to Excel/Sheets (CSV injection via an ad or lead name). */
const FORMULA_START = /^[=+\-@\t\r]/;

function toCsv(headers, records) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    // Numbers are never formulas; only text gets the guard (so -12.5 stays a number).
    const s = typeof v === 'number' ? String(v) : `${FORMULA_START.test(String(v)) ? "'" : ''}${String(v)}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(cell).join(','), ...records.map((r) => r.map(cell).join(','))].join('\n');
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

$('exportReport').addEventListener('click', () => {
  const rows = currentRows() || [];
  const cols = [{ k: 'name', l: 'Name' }, ...activeCols()];
  download(`hyros-${state.level}-${state.range}.csv`,
    toCsv(cols.map((c) => (c.t === 'money' ? `${c.l} (${fmt.currency})` : c.l)), rows.map((r) => cols.map((c) => c.k === 'name' ? (r.name || r.id) : r[c.k]))));
});

$('exportCrm').addEventListener('click', () => {
  const tab = state.crm.tab;
  const specs = { leads: CRM_COLUMNS, sales: SALES_COLUMNS, calls: CALLS_COLUMNS, subscriptions: SUBS_COLUMNS };
  const rows = tab === 'leads' ? crmRows() : (recordRows(tab) || []);
  const cols = specs[tab];
  download(`hyros-${tab}.csv`,
    toCsv(cols.map((c) => (c.money ? `${c.label} (${fmt.currency})` : c.label)), rows.map((r) => cols.map((c) => r[c.key]))));
});

boot();
