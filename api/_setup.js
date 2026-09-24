/**
 * Self-serve setup — what a HYROS user's fresh deployment needs before it can
 * show live data, kept in KV under `aihyros:config` so the ONLY thing Vercel
 * has to provide is the Upstash Redis store:
 *
 *   passwordHash   scrypt hash of the dashboard password (set on first load)
 *   keySecret      generated ACCOUNT_KEY_SECRET fallback (encrypts API keys at rest)
 *   cronSecret     generated CRON_SECRET, shown once so it can be pasted into Vercel
 *
 * Vercel env vars never decide whether the dashboard is set up — only the KV
 * config does, so a user never has to touch Vercel to start. ACCOUNT_KEY_SECRET
 * and CRON_SECRET in the env WIN over the generated copies (the "hardening"
 * step drops the KV copies once they match), and REPORT_PASSWORD, if set, is
 * accepted as an extra MASTER password (recovery) — it neither blocks nor
 * replaces the first-run flow. Nothing here is required for the Demo account,
 * which is client-side and always available.
 */
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readConfig, writeConfig, storeConfigured, storeCredentials, storeReadOnly, readAccounts, wipeAll } from './_store.js';
import { mcpUrl } from './_mcp.js';

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

/* Per-instance cache so every API call does not re-read the config. */
let cache = { cfg: undefined, at: 0 };
const TTL_MS = 15000;

export async function getConfig({ fresh = false } = {}) {
  if (!storeConfigured()) { cache = { cfg: null, at: Date.now() }; return null; }
  if (!fresh && cache.cfg !== undefined && Date.now() - cache.at < TTL_MS) return cache.cfg;
  const cfg = await readConfig();
  cache = { cfg, at: Date.now() };
  return cfg;
}

/** Last loaded config (sync). Handlers call checkAccess first, which warms it. */
export function cachedConfig() {
  return cache.cfg || null;
}

async function saveConfig(cfg) {
  if (!(await writeConfig(cfg))) throw fail('Could not write the setup config (KV write failed).', 502, 'kv');
  cache = { cfg, at: Date.now() };
  return cfg;
}

/* ---------- password ---------- */

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32);
  return `${salt.toString('hex')}.${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [s, h] = String(stored || '').split('.');
  if (!s || !h) return false;
  const want = Buffer.from(h, 'hex');
  const got = scryptSync(String(password), Buffer.from(s, 'hex'), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

export const passwordSource = (cfg) => (cfg?.passwordHash ? 'kv' : null);
export const masterPassword = () => Boolean(process.env.REPORT_PASSWORD);
export const keySecretSource = (cfg) => (process.env.ACCOUNT_KEY_SECRET ? 'env' : cfg?.keySecret ? 'kv' : null);
export const cronSecretSource = (cfg) => (process.env.CRON_SECRET ? 'env' : cfg?.cronSecret ? 'kv' : null);

/**
 * Key-encryption secrets in priority order: env first, then the KV fallback.
 * decryptKey tries each, so a key encrypted under the generated secret still
 * opens after the user moves it into Vercel (and vice versa).
 */
export function keySecrets(cfg = cachedConfig()) {
  return [process.env.ACCOUNT_KEY_SECRET, cfg?.keySecret]
    .filter(Boolean)
    .map((s) => createHash('sha256').update(s).digest());
}

/* ---------- state machine ---------- */

export async function setupState() {
  const cfg = await getConfig({ fresh: true });
  const storage = storeConfigured();
  const password = passwordSource(cfg);
  let accounts = 0;
  if (storage && password) accounts = (await readAccounts()).filter((a) => a.kind !== 'client').length;
  const state = !storage ? 'needs_storage' : !password ? 'needs_setup' : 'ready';
  return {
    state, storage, storeVia: storeCredentials()?.via || null, readOnly: storeReadOnly(),
    passwordSource: password, masterPassword: masterPassword(),
    keySecret: keySecretSource(cfg), cronSecret: cronSecretSource(cfg),
    // "Hardened" = no generated secret is still sitting in KV.
    pendingSecrets: Boolean(cfg?.keySecret || cfg?.cronSecret),
    accounts, mcpUrl: mcpUrl(), createdAt: cfg?.createdAt || null,
  };
}

/**
 * First-run password. Refused once one exists. A first run is a FRESH START:
 * every app key already in the store (an earlier install's snapshots,
 * accounts, prefs) is wiped before the new config is written.
 */
export async function setPassword(password) {
  if (!storeConfigured()) throw fail('Storage is not set up yet — add the Upstash Redis store first.', 503, 'needs_storage');
  const cfg = (await getConfig({ fresh: true })) || {};
  if (passwordSource(cfg)) throw fail('This dashboard is already set up. Sign in with its password.', 409, 'exists');
  if (String(password || '').length < 8) throw fail('Use at least 8 characters.', 400, 'weak');
  await wipeAll();
  const next = { passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
  if (!process.env.ACCOUNT_KEY_SECRET) next.keySecret = randomBytes(32).toString('hex');
  if (!process.env.CRON_SECRET) next.cronSecret = randomBytes(32).toString('hex');
  await saveConfig(next);
  return setupState();
}

export async function changePassword(password) {
  const cfg = (await getConfig({ fresh: true })) || {};
  if (!passwordSource(cfg)) throw fail('Not set up yet.', 409, 'needs_setup');
  if (String(password || '').length < 8) throw fail('Use at least 8 characters.', 400, 'weak');
  await saveConfig({ ...cfg, passwordHash: hashPassword(password), passwordChangedAt: new Date().toISOString() });
  return setupState();
}

/** The generated secrets, for the (password-gated) hardening screen. Gone once hardened. */
export async function pendingSecrets() {
  const cfg = (await getConfig({ fresh: true })) || {};
  return {
    ACCOUNT_KEY_SECRET: process.env.ACCOUNT_KEY_SECRET ? null : cfg.keySecret || null,
    CRON_SECRET: process.env.CRON_SECRET ? null : cfg.cronSecret || null,
  };
}

/**
 * Hardening: once the generated values are pasted into Vercel as env vars,
 * drop them from KV. Each one is dropped ONLY when the env value matches, so
 * a typo can never orphan the encrypted keys.
 */
export async function harden() {
  const cfg = (await getConfig({ fresh: true })) || {};
  const next = { ...cfg };
  const done = {};
  done.ACCOUNT_KEY_SECRET = Boolean(cfg.keySecret) && process.env.ACCOUNT_KEY_SECRET === cfg.keySecret;
  done.CRON_SECRET = Boolean(cfg.cronSecret) && process.env.CRON_SECRET === cfg.cronSecret;
  if (done.ACCOUNT_KEY_SECRET) delete next.keySecret;
  if (done.CRON_SECRET) delete next.cronSecret;
  if (done.ACCOUNT_KEY_SECRET || done.CRON_SECRET) { next.hardenedAt = new Date().toISOString(); await saveConfig(next); }
  return {
    done,
    remaining: { ACCOUNT_KEY_SECRET: Boolean(next.keySecret), CRON_SECRET: Boolean(next.cronSecret) },
    envSet: { ACCOUNT_KEY_SECRET: Boolean(process.env.ACCOUNT_KEY_SECRET), CRON_SECRET: Boolean(process.env.CRON_SECRET) },
  };
}

/** Factory reset: every app key in KV goes (accounts, snapshots, prefs, config). */
export async function factoryReset() {
  const deleted = await wipeAll();
  cache = { cfg: null, at: Date.now() };
  return { deleted, ...(await setupState()) };
}
