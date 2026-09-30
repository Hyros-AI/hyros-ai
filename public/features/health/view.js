/**
 * Tracking Health — script presence + tracking parameters. Renders ctx.block
 * into ctx.root. Every tile and panel says what its check did this refresh
 * (block.checks: ok | empty | skipped | failed, with the reason), so a "—"
 * is never left unexplained and no empty state is invented.
 */
const SCRIPT_OK = new Set(['SCRIPT_FOUND', 'FOUND', 'OK', 'PRESENT', 'INSTALLED']);
// snapshot.warnings[].kind -> pill text. Skips are quiet, failures are bad.
const WARN_LABEL = { unsupported: 'skipped: unsupported', 'time budget': 'skipped: time budget', rate_limited: 'rate limited', truncated: 'truncated', error: 'error' };
const WARN_BAD = new Set(['rate_limited', 'error']);
const CHECK_NAME = { domains: 'verified domains', script: 'script presence', params: 'tracking params', visits: 'recent visits' };
const STATUS_PILL = { ok: 'ok', empty: '', skipped: 'warn', failed: 'bad' };
const SKIP_LINE = {
  'time budget': 'Skipped this refresh (time budget) — press Refresh again.',
  'no verified domains': 'No verified domains on this account — add one in HYROS.',
  'domains check failed': 'Skipped — the domain list could not be fetched (see Check errors).',
  'no Google ad accounts connected': 'No Google ad accounts connected — nothing to check.',
};
const MAX_SUB_CHARS = 48;

/** A failure reason short enough for a KPI sub: the first clause, capped. */
function shortReason(reason) {
  const clause = String(reason || '').split(' (')[0].trim();
  return clause.length > MAX_SUB_CHARS ? `${clause.slice(0, MAX_SUB_CHARS - 1)}…` : clause;
}

/** The status line for a check that produced no rows to show. */
function statusLine(check) {
  if (check.status === 'failed') return `Check failed: ${check.reason || 'unknown error'}`;
  if (check.status === 'skipped') return SKIP_LINE[check.reason] || `Skipped: ${check.reason || 'unknown reason'}.`;
  return null;
}

/** `checks` for a block from before they existed, inferred from its data and error strings. */
function legacyChecks(h) {
  const err = (prefix) => (h.errors || []).find((e) => typeof e === 'string' && e.startsWith(prefix));
  const infer = (has, prefix) => {
    if (has) return { status: 'ok' };
    const e = err(prefix);
    if (!e) return { status: 'empty' };
    return /skipped \(time budget\)/.test(e) ? { status: 'skipped', reason: 'time budget' } : { status: 'failed', reason: e.slice(prefix.length) };
  };
  return {
    domains: infer((h.domains || []).length, 'domains: '),
    script: infer(Object.keys(h.scripts || {}).length, 'script: '),
    params: infer((h.trackingParams || []).length, 'params '),
  };
}

/** KPI sub for a check that is not ok, in the tile's mono voice. */
function checkSub(check, { notRun, emptyText }) {
  if (notRun) return 'not checked';
  if (check.status === 'skipped') return check.reason === 'time budget' ? 'skipped: time budget' : (check.reason || 'skipped');
  if (check.status === 'failed') return `failed: ${shortReason(check.reason)}`;
  return emptyText;
}

/** Which channels the params check covered: "checked: A, B" or per-channel outcomes when they differ. */
function channelsSub(check, fallback) {
  const entries = Object.entries(check.channels || {});
  if (!entries.length) return fallback;
  const ran = (s) => s === 'ok' || s === 'empty';
  if (entries.every(([, s]) => ran(s))) return `checked: ${entries.map(([t]) => t).join(', ')}`;
  return entries.map(([t, s]) => `${t} ${ran(s) ? 'checked' : s}`).join(' · ');
}

/** One pill per distinct warning kind for this ad account (core snapshot.warnings), escaped. */
function warningPills(adAccount, warnings, esc) {
  const mine = warnings.filter((w) => String(w?.adAccountId) === String(adAccount.id));
  const kinds = [...new Set(mine.map((w) => w?.kind || 'error'))];
  return kinds.map((kind) => {
    const detail = mine.filter((w) => (w?.kind || 'error') === kind).map((w) => [w.level, w.error].filter(Boolean).join(': ')).join(' · ');
    return `<span class="pill ${WARN_BAD.has(kind) ? 'bad' : 'warn'}" title="${esc(detail)}">${esc(WARN_LABEL[kind] || `skipped: ${kind}`)}</span>`;
  }).join('');
}

const statusRow = (check, esc, text) => `<div class="health-status"><span class="pill ${STATUS_PILL[check.status] || ''}">${esc(check.status)}</span><span class="health-msg">${esc(text)}</span></div>`;

/** "Checks this refresh": one row per check with its status, reason and duration. */
function checksPanel(checks, h, fmt, esc) {
  const detail = {
    domains: checks.domains.status === 'ok' ? `${fmt.int((h.domains || []).length)} verified` : '',
    script: checks.script.status === 'ok' ? `${fmt.int(Object.keys(h.scripts || {}).length)} URLs fetched` : '',
    params: checks.params.status === 'ok' || checks.params.status === 'empty' ? channelsSub(checks.params, '') : '',
    visits: checks.visits?.status === 'ok' ? `visits on ${fmt.int((h.visitedHosts || []).length)} hosts in 7 days` : '',
  };
  // A visits check skipped because nothing needed confirming is not worth amber.
  const pillOf = (id, c) => (id === 'visits' && c.status === 'skipped' ? '' : STATUS_PILL[c.status] || '');
  return `<div class="fpanel"><h3>Checks this refresh</h3>
    <div class="fhint">what each HYROS check did — a skip is not an error, a failure is</div>
    ${Object.entries(checks).map(([id, c]) => `<div class="health-row"><span class="pill ${pillOf(id, c)}">${esc(c.status)}</span><code>${esc(CHECK_NAME[id] || id)}</code>
      <span class="health-msg">${esc(c.status === 'ok' || c.status === 'empty' ? detail[id] || (c.status === 'empty' ? 'ran, nothing found' : '') : (c.reason || ''))}</span>
      ${Number.isFinite(c.ms) ? `<span class="sub">${esc(`${(c.ms / 1000).toFixed(1)} s`)}</span>` : ''}</div>`).join('')}
  </div>`;
}

/** Every error, full size: a bad pill with the check name, then its message. */
function errorsPanel(errors, esc) {
  return `<div class="fpanel health-errors"><h3>Check errors</h3>
    <div class="fhint">each line is one check's own message from this refresh</div>
    ${errors.map((e) => { const i = String(e).indexOf(': '); const name = i > 0 ? String(e).slice(0, i) : 'check'; const msg = i > 0 ? String(e).slice(i + 2) : String(e);
      return `<div class="health-row"><span class="pill bad">${esc(name)}</span><span class="health-msg">${esc(msg)}</span></div>`; }).join('')}
  </div>`;
}

const isTimeoutStatus = (st) => /TIMEOUT/i.test(String(st));

/**
 * One entry per tracking domain: its site variants with their status; found
 * when any variant has the script, visited when it has not but HYROS recorded
 * visits on the site (the check reads the raw page and misses injected
 * scripts), timedOut when every checked variant timed out — not "checked".
 */
function groupSites(sites, scripts, visitedHosts = []) {
  const visitedSet = new Set(visitedHosts);
  const byDomain = new Map();
  for (const s of sites) {
    const list = byDomain.get(s.trackingDomain) || [];
    byDomain.set(s.trackingDomain, [...list, { url: s.url, status: scripts[s.url] ?? null }]);
  }
  return [...byDomain.entries()].map(([trackingDomain, variants]) => {
    const checkedVariants = variants.filter((v) => v.status !== null);
    const foundOn = checkedVariants.filter((v) => SCRIPT_OK.has(String(v.status).toUpperCase())).map((v) => v.url);
    const site = (variants[0]?.url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    const found = foundOn.length > 0;
    const timedOut = checkedVariants.length > 0 && checkedVariants.every((v) => isTimeoutStatus(v.status));
    const checked = checkedVariants.some((v) => !isTimeoutStatus(v.status));
    const host = site.toLowerCase();
    const visited = !found && checked && [...visitedSet].some((v) => v === host || v.endsWith(`.${host}`));
    return { trackingDomain, site, variants, checked, timedOut, found, visited, foundOn };
  });
}

function siteRow(g, checks, stale, fmt, esc) {
  const pill = g.timedOut ? '<span class="pill warn">couldn&#39;t check (timeout)</span>'
    : !g.checked ? '<span class="pill">not checked</span>'
    : g.visited ? '<span class="pill warn">not detected · visits tracked</span>'
    : g.found ? `<span class="pill ok">script found${g.foundOn.some((u) => /\/\/www\./.test(u)) && !g.foundOn.some((u) => !/\/\/www\./.test(u)) ? ' (on www)' : ''}</span>`
    : '<span class="pill bad">script not found</span>';
  const variants = g.variants.map((v) => `<span class="sub">${esc(v.url)} · ${esc(v.status === null ? 'not checked' : String(v.status).toLowerCase().replace(/_/g, ' '))}</span>`).join('');
  return `<div class="health-row health-site"><code title="${esc(g.site)}">${esc(g.site)}</code>
    <span class="sub">tracking domain ${esc(g.trackingDomain)}</span>
    ${stale ? `<span class="pill">previous check · ${esc(checks.script.checkedAt ? fmt.datetime(checks.script.checkedAt) : 'earlier refresh')}</span>` : ''}
    ${pill}</div><div class="health-variants">${variants}</div>`;
}

export function render(ctx) {
  const { fmt, esc, kpis, snapshot } = ctx;
  const h = ctx.block;
  if (!h) { ctx.root.innerHTML = '<div class="fpanel"><div class="empty">No health check in this snapshot — hit Refresh.</div></div>'; return; }
  // Only a block with a checkedAt actually ran; a bare { skipped } did not.
  const notRun = !h.checkedAt;
  const checks = { ...legacyChecks(h), ...(h.checks || {}) };
  const scripts = Object.entries(h.scripts || {});
  const okCount = scripts.filter(([, st]) => SCRIPT_OK.has(String(st).toUpperCase())).length;
  // Group the checked URLs by site (one tracking domain = one site): the
  // script counts as present when ANY variant (apex or www) carries it,
  // because the MCP does not follow the apex -> www redirect most sites use.
  const siteGroups = groupSites(h.sites || [], h.scripts || {}, h.visitedHosts || []);
  const sitesChecked = siteGroups.filter((g) => g.checked).length;
  const sitesOk = siteGroups.filter((g) => g.found || g.visited).length;
  const sitesMissing = siteGroups.filter((g) => g.checked && !g.found && !g.visited).length;
  const sitesUnsure = siteGroups.filter((g) => g.visited || (g.timedOut && !g.checked)).length;
  const sitesTimedOut = siteGroups.filter((g) => g.timedOut && !g.checked).length;
  const plural = (n, w) => `${fmt.int(n)} ${w}${n === 1 ? '' : 's'}`;
  const sitesValue = sitesChecked ? `${sitesOk} / ${sitesChecked}` : '—';
  const sitesCls = sitesMissing ? 'bad' : (!sitesChecked || sitesUnsure ? '' : 'good');
  const sitesSub = sitesChecked
    ? `of ${plural(sitesChecked, 'site')} checked (${fmt.int(Object.keys(h.scripts || {}).length)} URLs)${sitesTimedOut ? ` · ${plural(sitesTimedOut, 'site')} couldn't be checked` : ''}`
    : `${plural(sitesTimedOut, 'site')} couldn't be checked (timeout)`;
  const useSites = siteGroups.length > 0;
  const paramRows = (h.trackingParams || []).flatMap((p) => (p.rows || []).map((r) => ({ ...r, _type: p.type })));
  const flagged = paramRows.filter((r) => r && (r.valid === false || r.missing || r.ok === false || /missing|invalid/i.test(JSON.stringify(r))));
  const errors = (h.errors || []).map(String);
  const acct = snapshot.account || {};
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
  const hasGoogle = (snapshot.adAccounts || []).some((a) => /GOOGLE/.test(a.type || ''));
  const scriptStale = checks.script.stale === true && scripts.length > 0;
  const status = h.skipped
    ? (h.stale
      ? `<br>Skipped this refresh (${esc(h.skipped)}) — showing the previous check${h.checkedAt ? ` from ${esc(fmt.datetime(h.checkedAt))}` : ''}.`
      : `<br>Skipped this refresh (${esc(h.skipped)}) — nothing was checked yet. Hit Refresh again.`)
    : '';
  const scriptLine = notRun ? 'Not checked this refresh.' : (statusLine(checks.script) || (!(h.domains || []).length ? SKIP_LINE['no verified domains'] : 'No script check result.'));
  const paramsLine = notRun ? 'Not checked this refresh.' : (!hasGoogle ? SKIP_LINE['no Google ad accounts connected']
    : (statusLine(checks.params) || (checks.params.status === 'empty' ? 'No ads reported by the check in the last hour.' : 'No check result.')));

  ctx.root.innerHTML = `
    <div class="note"><b>Tracking Health.</b> Is the HYROS script actually on your
      domains, and do your ad links carry the parameters attribution needs? Checked by HYROS itself
      (<code>hyros_assert_script_presence_on_domain</code>, <code>hyros_check_tracking_parameters_for_integrations</code>)
      ${h.checkedAt ? `at ${esc(fmt.datetime(h.checkedAt))}` : ''}.
      ${h.error ? `<br><b>Error:</b> ${esc(h.error)}` : ''}${status}
      ${ctx.demo ? ' <span class="pill warn">demo</span>' : ''}</div>
    <div class="kpis">${kpis([
      { label: 'Verified domains', value: notRun ? '—' : fmt.int((h.domains || []).length), sub: notRun ? 'not checked' : (checks.domains.status === 'failed' ? `failed: ${shortReason(checks.domains.reason)}` : '') },
      { label: 'Script present', value: checks.script.status === 'ok' && scripts.length ? (useSites ? sitesValue : `${okCount} / ${scripts.length}`) : '—',
        cls: checks.script.status === 'ok' && scripts.length ? (useSites ? sitesCls : (okCount < scripts.length ? 'bad' : 'good')) : '',
        sub: checks.script.status === 'ok' && scripts.length ? (useSites ? sitesSub : `of ${fmt.int(scripts.length)} URLs checked`) : checkSub(checks.script, { notRun, emptyText: 'no result' }) },
      { label: 'Ads missing tracking params', value: checks.params.status === 'ok' && paramRows.length ? fmt.int(flagged.length) : '—',
        cls: checks.params.status === 'ok' && paramRows.length ? (flagged.length ? 'bad' : 'good') : '',
        sub: checks.params.status === 'ok' && paramRows.length ? channelsSub(checks.params, (h.trackingParams || []).map((p) => p.type).join(', '))
          : (!hasGoogle && !notRun ? 'no Google ad accounts' : checkSub(checks.params, { notRun, emptyText: `${channelsSub(checks.params, 'checked')}: no ads in the last hour` })) },
      { label: 'Check errors', value: notRun ? '—' : fmt.int(errors.length), cls: errors.length ? 'bad' : '', sub: errors.length ? shortReason(errors[0]) : (notRun ? 'not checked' : 'none') },
    ])}</div>
    ${notRun ? '' : errors.length ? `<div class="fcols">${checksPanel(checks, h, fmt, esc)}${errorsPanel(errors, esc)}</div>` : checksPanel(checks, h, fmt, esc)}
    <div class="fcols">
      <div class="fpanel"><h3>Script presence</h3>
        <div class="fhint">the universal script, fetched and inspected on the site behind each verified tracking domain (apex and www, 3 URLs per call — the MCP's limit). The check reads the raw page, so a script your site builder injects can read "not found": a site where HYROS recorded visits in the last 7 days counts as tracked</div>
        ${scriptStale || (checks.script.status !== 'ok' && !notRun && statusLine(checks.script)) ? statusRow(checks.script, esc, `${statusLine(checks.script) || ''}${scriptStale ? ` Showing the previous check${checks.script.checkedAt ? ` from ${fmt.datetime(checks.script.checkedAt)}` : ''}.` : ''}`) : ''}
        ${scripts.length ? (useSites ? siteGroups.map((g) => siteRow(g, checks, scriptStale, fmt, esc)).join('') : scripts.map(([url, st]) => {
          const ok = SCRIPT_OK.has(String(st).toUpperCase());
          return `<div class="health-row"><code title="${esc(url)}">${esc(url)}</code>
            ${scriptStale ? `<span class="pill">previous check · ${esc(checks.script.checkedAt ? fmt.datetime(checks.script.checkedAt) : 'earlier refresh')}</span>` : ''}
            <span class="pill ${ok ? 'ok' : 'bad'}">${esc(String(st).toLowerCase().replace(/_/g, ' '))}</span></div>`;
        }).join('')) : (statusLine(checks.script) && !notRun ? '' : `<div class="empty">${esc(scriptLine)}</div>`)}
      </div>
      <div class="fpanel"><h3>Account &amp; access</h3>
        <div class="fhint">connected ad accounts and agency relationships (MCP: allowedAccounts / accessibleAccounts)</div>
        ${(snapshot.adAccounts || []).map((a) => `<div class="health-row"><code>${esc(a.name)}</code><span class="pill">${esc(a.type)}</span><span class="sub">${esc(a.id)}</span>${warningPills(a, warnings, esc)}</div>`).join('')}
        ${(acct.managedBy || []).map((a) => `<div class="health-row"><code>managed by ${esc(a.email || a.company || a.accountId || '—')}</code><span class="pill ${a.status === 'APPROVED' ? 'ok' : ''}">${esc(a.status || '')}</span></div>`).join('')}
        ${(acct.clients || []).map((a) => `<div class="health-row"><code>client ${esc(a.email || a.company || a.accountId || '—')}</code><span class="pill ${a.status === 'APPROVED' ? 'ok' : ''}">${esc(a.status || '')}</span></div>`).join('')}
        ${acct.attributionWindowDefault ? `<div class="health-row"><code>account attribution window</code><span class="pill">${esc(acct.attributionWindowDefault)} days</span></div>` : ''}
      </div>
    </div>
    <div class="fpanel"><h3>Ad link tracking parameters</h3>
      <div class="fhint">per ad, whether the parameters HYROS needs are present and well-formed (Google channels seen in the last hour)</div>
      ${paramRows.length ? paramRows.slice(0, 50).map((r) => {
        const bad = flagged.includes(r);
        const label = r.adName || r.name || r.ad || r.adId || r.id || JSON.stringify(r).slice(0, 80);
        return `<div class="health-row"><span class="pill">${esc(r._type)}</span><code title="${esc(JSON.stringify(r))}">${esc(String(label))}</code>
          <span class="pill ${bad ? 'bad' : 'ok'}">${bad ? 'missing / invalid' : 'ok'}</span></div>`;
      }).join('') : (hasGoogle && !notRun && statusLine(checks.params) ? statusRow(checks.params, esc, paramsLine) : `<div class="empty">${esc(paramsLine)}</div>`)}
    </div>`;
}
