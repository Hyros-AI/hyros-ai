/**
 * POST|GET /api/refresh -> rebuild the snapshot from the MCP and persist it.
 *
 * Triggered by Vercel Cron daily (Authorization: Bearer $CRON_SECRET) or
 * on demand from the dashboard's Refresh button (password-gated).
 *
 * Every outcome is a structured log line (api/_log.js): `refresh.ok` with
 * the timing and warning count, `refresh.failed` with the error code — the
 * only trace a template owner has when a user reports "it failed".
 */
import { checkAccess, isCron, deny } from './_auth.js';
import { buildSnapshot, fitSnapshot } from './_snapshot.js';
import { writeSnapshot, readSnapshot, readPrefs, storeConfigured, storeReadOnly, kvRaw } from './_store.js';
import { McpNotConfigured } from './_mcp.js';
import { accountFromReq, asAccount, listAccounts, markKeyStatus, noteRefresh, syncClients } from './_accounts.js';
import { logEvent } from './_log.js';
import { REFRESH_MAX_S, REFRESH_BUDGET_MS, CRON_BUDGET_MS, CRON_MIN_ACCOUNT_MS, cronAccountBudgetMs } from './_budget.js';

/**
 * Vercel function limit (seconds). Also declared in vercel.json so the
 * platform honours it; both derive from api/_budget.js REFRESH_MAX_S. Hobby
 * projects without Fluid compute must lower it to 60 there.
 */
export const maxDuration = REFRESH_MAX_S;

/** Build + persist one account's snapshot under its own key. */
async function refreshAccount(accountId, steps, budgetMs) {
  const started = Date.now();
  const [prefs, previous] = storeConfigured()
    ? await Promise.all([readPrefs(accountId), readSnapshot(accountId)])
    : [null, null];
  let snapshot;
  try {
    snapshot = await asAccount(accountId, () =>
      buildSnapshot({ onProgress: (s) => steps.push(`${accountId}: ${s}`), prefs, previous, budgetMs }));
  } catch (err) {
    logEvent('refresh.failed', { accountId, code: err.code || err.name || 'error', message: err.message, ms: Date.now() - started });
    // Only a rejected key (401) marks the account (or its agency) invalid so
    // the selector can say so instead of 40 clients failing one by one. A
    // 403 (missing role, client not authorized) is recorded as the last
    // error but never flips the key status.
    if (storeConfigured()) {
      if (err.code === 'auth') await markKeyStatus(accountId, 'invalid', err.message);
      await noteRefresh(accountId, false, err.message);
    }
    throw err;
  }
  snapshot = fitSnapshot(snapshot);
  const persisted = storeConfigured() ? await writeSnapshot(snapshot, accountId) : false;
  if (storeConfigured()) { await markKeyStatus(accountId, 'ok'); await noteRefresh(accountId, true); }
  logEvent('refresh.ok', { accountId, ms: Date.now() - started, warnings: snapshot.warnings?.length || 0, persisted });
  return { snapshot, persisted };
}

/**
 * Cron with no ?account=: which accounts to refresh, stalest first. Clients
 * of an agency whose accessible_account_id mode is unsupported cannot be
 * read at all, so they are listed as skipped instead of failing daily.
 */
function cronTargets(listed) {
  const byId = new Map(listed.map((a) => [a.id, a]));
  const unsupported = (a) => a.parentId && byId.get(a.parentId)?.clientModeStatus === 'unsupported';
  const candidates = listed.filter((a) => a.keyStatus !== 'invalid' && a.status === 'APPROVED');
  return {
    skipped: candidates.filter(unsupported).map((a) => ({ id: a.id, skipped: 'unsupported' })),
    accounts: candidates.filter((a) => !unsupported(a))
      .sort((a, b) => String(a.lastRefresh || '').localeCompare(String(b.lastRefresh || ''))),
  };
}

export default async function handler(req, res) {
  const cron = isCron(req);
  if (!cron) {
    const access = await checkAccess(req);
    if (!access.ok) return deny(res, access);
  } else if (!process.env.CRON_SECRET) {
    // Unsigned cron (CRON_SECRET not pasted into Vercel yet): at most one run per hour.
    if (!storeConfigured()) return res.status(503).json({ ok: false, error: 'needs_storage' });
    const lock = await kvRaw(['SET', 'aihyros:cron:lock', new Date().toISOString(), 'NX', 'EX', '3000']);
    if (lock === null) return res.status(429).json({ ok: false, error: 'cron_locked', message: 'An unsigned cron run already happened this hour. Set CRON_SECRET in Vercel to lift the limit.' });
  }

  const steps = [];
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);

  // Cron with no ?account=: refresh the stalest accounts, one after another,
  // until the function's time budget is spent; the rest wait for the next run.
  if (cron && !url.searchParams.get('account')) {
    const listed = await listAccounts({ withStatus: true });
    // Agencies: pick up new / revoked clients (one cheap call each).
    const synced = [];
    for (const a of listed.filter((x) => x.agency && x.keyStatus !== 'invalid')) {
      try { synced.push({ id: a.id, ...(await syncClients(a.id)) }); } catch (err) { synced.push({ id: a.id, error: err.message }); }
    }
    const { accounts, skipped } = cronTargets(await listAccounts({ withStatus: true }));
    const done = [...skipped];
    // Stalest first; each account gets min(what is left, 120 s) and the loop
    // runs until the budget is spent, so a big agency is spread over runs.
    for (const a of accounts) {
      const left = CRON_BUDGET_MS - (Date.now() - started);
      if (left < CRON_MIN_ACCOUNT_MS) { done.push({ id: a.id, skipped: 'time budget' }); continue; }
      try {
        const { persisted } = await refreshAccount(a.id, steps, cronAccountBudgetMs(left));
        done.push({ id: a.id, ok: true, persisted });
      } catch (err) { done.push({ id: a.id, ok: false, error: err.message }); }
    }
    return res.status(200).json({ ok: true, cron: true, ms: Date.now() - started, budgetMs: CRON_BUDGET_MS, elapsedMs: Date.now() - started, accounts: done, synced, steps });
  }

  const accountId = await accountFromReq(req);
  if (!accountId) {
    return res.status(503).json({ ok: false, error: 'not_configured', message: 'No HYROS account is connected yet — add one from the account menu.' });
  }

  try {
    const { snapshot, persisted } = await refreshAccount(accountId, steps, REFRESH_BUDGET_MS);

    res.status(200).json({
      ok: true,
      account: accountId,
      persisted,
      storeConfigured: storeConfigured(),
      readOnly: storeReadOnly(),
      warning: !storeConfigured()
        ? 'KV is not configured, so this snapshot was not stored. Set KV_REST_API_URL / KV_REST_API_TOKEN.'
        : storeReadOnly()
          ? 'This is a Vercel preview deployment: the snapshot was built but not stored (previews never write to the production store).'
          : undefined,
      ms: Date.now() - started,
      // Budget vs. spent, so the client can show how much of the 5 minutes
      // a large account really needed (`ms` is kept for older clients).
      budgetMs: REFRESH_BUDGET_MS,
      elapsedMs: Date.now() - started,
      steps,
      generatedAt: snapshot.generatedAt,
      templateVersion: snapshot.templateVersion,
      settings: snapshot.settings,
      counts: {
        adAccounts: snapshot.adAccounts.length,
        sources: snapshot.sourceCount,
        leads: snapshot.crm.leads.length,
        sales: snapshot.crm.sales?.length ?? 0,
        calls: snapshot.crm.calls?.length ?? 0,
        subscriptions: snapshot.crm.subscriptions?.length ?? 0,
        leadsFetched: snapshot.crm.sync?.leadsFetched,
        incremental: snapshot.crm.sync?.incremental,
        warnings: snapshot.warnings?.length || 0,
        curves: snapshot.scale?.curves?.length ?? 0,
      },
    });
  } catch (err) {
    const status = err instanceof McpNotConfigured ? 503 : (err.status || 502);
    res.status(status).json({
      ok: false,
      error: err.code || err.name || 'error',
      message: err.message,
      detail: err.detail ?? undefined,
      storeConfigured: storeConfigured(),
      steps,
      ms: Date.now() - started,
      budgetMs: REFRESH_BUDGET_MS,
      elapsedMs: Date.now() - started,
    });
  }
}
