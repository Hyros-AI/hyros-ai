/**
 * Snapshot persistence via Upstash Redis / Vercel KV REST.
 * No npm dependency — plain fetch, same pattern the lander uses.
 * Every function fails soft: a KV outage degrades to the seed, never a 500.
 */

const KEY = 'aihyros:snapshot:latest';
const HISTORY_PREFIX = 'aihyros:snapshot:';
const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

/**
 * Multi-account layout. The PRIMARY account (the HYROS_API_KEY from the
 * environment, id "env") keeps the original keys so existing deployments
 * carry on untouched; every added account gets its own namespace.
 */
export const PRIMARY_ID = 'env';
const ACCOUNTS_KEY = 'aihyros:accounts';
const snapKey = (id) => (!id || id === PRIMARY_ID ? KEY : `aihyros:acct:${id}:snapshot`);
const histKey = (id, day) => (!id || id === PRIMARY_ID ? `${HISTORY_PREFIX}${day}` : `aihyros:acct:${id}:snapshot:${day}`);
const acctPrefsKey = (id) => `aihyros:acct:${id}:prefs`;

/**
 * Resolve the Redis REST credentials whatever Vercel decided to call them.
 *
 * Vercel names these differently depending on how the database was
 * provisioned, and if a variable name is already taken it forces a CUSTOM
 * PREFIX on the whole set (STORAGE_REST_API_URL, and so on). Rather than make
 * anyone rename variables by hand, try the two canonical pairs and then fall
 * back to discovering any `<PREFIX>_REST_API_URL` that has a matching
 * `<PREFIX>_REST_API_TOKEN` beside it.
 */
const EXPLICIT_PAIRS = [
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
];

export function storeCredentials() {
  for (const [urlKey, tokenKey] of EXPLICIT_PAIRS) {
    const url = process.env[urlKey];
    const token = process.env[tokenKey];
    if (url && token) return { url, token, via: urlKey };
  }

  // Prefixed set, e.g. STORAGE_REST_API_URL + STORAGE_REST_API_TOKEN.
  // The _URL -> _TOKEN swap deliberately never matches
  // KV_REST_API_READ_ONLY_TOKEN, which is a different credential.
  for (const [key, url] of Object.entries(process.env)) {
    if (!key.endsWith('_REST_API_URL') || !url) continue;
    const token = process.env[`${key.slice(0, -4)}_TOKEN`];
    if (token) return { url, token, via: key };
  }
  return null;
}

export function storeConfigured() {
  return storeCredentials() !== null;
}

/**
 * Vercel preview deployments share the production store when Upstash is
 * connected to "all environments", so a Refresh, setup or reset on a preview
 * URL would overwrite live data. Previews read; they never write.
 */
export function storeReadOnly() {
  return process.env.VERCEL_ENV === 'preview' ? 'preview' : null;
}

const WRITE_COMMANDS = new Set(['SET', 'DEL']);

async function kv(command) {
  const creds = storeCredentials();
  if (!creds) return null;
  if (storeReadOnly() && WRITE_COMMANDS.has(String(command[0]).toUpperCase())) return null;
  try {
    const res = await fetch(creds.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.result ?? null;
  } catch {
    return null;
  }
}

const PREFS_KEY = 'aihyros:prefs';
const CONFIG_KEY = 'aihyros:config';

/** Raw KV command for the few callers that need one (setup, cron lock). */
export async function kvRaw(command) {
  return kv(command);
}

/** Self-serve setup config: password hash + generated secrets (see _setup.js). */
export async function readConfig() {
  return readJson(CONFIG_KEY);
}

export async function writeConfig(cfg) {
  return (await kv(['SET', CONFIG_KEY, JSON.stringify(cfg)])) !== null;
}

/**
 * Factory reset: delete EVERY key this app owns (config, accounts registry,
 * every snapshot + history copy, prefs). SCAN + DEL so nothing is missed —
 * dated history keys cannot be enumerated any other way.
 */
export async function wipeAll() {
  let cursor = '0';
  let deleted = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const r = await kv(['SCAN', cursor, 'MATCH', 'aihyros:*', 'COUNT', '200']);
    if (!Array.isArray(r)) break;
    const [next, keys] = r;
    if (Array.isArray(keys) && keys.length) {
      const n = await kv(['DEL', ...keys]);
      if (typeof n === 'number') deleted += n;
    }
    cursor = String(next);
    if (cursor === '0') break;
  }
  return deleted;
}

async function readJson(key) {
  const raw = await kv(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Prefs: column loadout is GLOBAL (one saved view for the dashboard); report
 * settings are PER ACCOUNT (attribution window / stage ranking differ by
 * business). The primary account's settings live in the global object for
 * backward compatibility.
 */
export async function readPrefs(accountId = PRIMARY_ID) {
  const global = (await readJson(PREFS_KEY)) || null;
  if (!accountId || accountId === PRIMARY_ID) return global;
  const own = (await readJson(acctPrefsKey(accountId))) || {};
  return { ...(global || {}), settings: own.settings, savedAt: own.savedAt || global?.savedAt };
}

export async function writePrefs(prefs, accountId = PRIMARY_ID) {
  if (!accountId || accountId === PRIMARY_ID) {
    return (await kv(['SET', PREFS_KEY, JSON.stringify(prefs)])) !== null;
  }
  // Split: cols → global, settings → this account.
  const ok = [];
  if (prefs.cols) {
    const global = (await readJson(PREFS_KEY)) || {};
    ok.push(await kv(['SET', PREFS_KEY, JSON.stringify({ ...global, cols: prefs.cols, savedAt: prefs.savedAt })]));
  }
  if (prefs.settings) {
    ok.push(await kv(['SET', acctPrefsKey(accountId), JSON.stringify({ settings: prefs.settings, savedAt: prefs.savedAt })]));
  }
  return ok.every((r) => r !== null);
}

export async function readSnapshot(accountId = PRIMARY_ID) {
  return readJson(snapKey(accountId));
}

export async function writeSnapshot(snapshot, accountId = PRIMARY_ID) {
  const payload = JSON.stringify(snapshot);
  const day = (snapshot.generatedAt || new Date().toISOString()).slice(0, 10);
  const ok = await kv(['SET', snapKey(accountId), payload]);
  // Keep a dated copy so a bad refresh can be compared against yesterday.
  await kv(['SET', histKey(accountId, day), payload, 'EX', String(TTL_SECONDS)]);
  return ok !== null;
}

export async function deleteAccountData(accountId) {
  if (!accountId || accountId === PRIMARY_ID) return false;
  await kv(['DEL', snapKey(accountId), acctPrefsKey(accountId)]);
  return true;
}

/** The added-accounts registry (encrypted keys — see _accounts.js). */
export async function readAccounts() {
  return (await readJson(ACCOUNTS_KEY))?.accounts || [];
}

export async function writeAccounts(accounts) {
  return (await kv(['SET', ACCOUNTS_KEY, JSON.stringify({ accounts, savedAt: new Date().toISOString() })])) !== null;
}
