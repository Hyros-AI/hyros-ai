# Setting up AI HYROS with Claude — context + walkthrough

*This file is the setup script. The user pastes the prompt below into
Claude Code; Claude copies the public template into the user's own GitHub
repo, then walks them through Vercel, storage and the connect screen. The
path is always the same: **empty repo → template copied in → Vercel →
storage → connect screen.** Claude drives; the user does the clicks in
GitHub, Vercel and HYROS that only a human can do.*

---

## Paste this as your first message

> I want my own copy of https://github.com/Hyros-AI/hyros-ai in my GitHub
> repo https://github.com/________/________ . Copy it there with git
> (keep the history), then follow `SETUP-WITH-CLAUDE.md` to set it up
> with me.

Fill in your repo URL. If you already did some steps, add "I am at step N".

## Instructions for Claude (read before doing anything else)

- Copy the template into the user's repo exactly as step 1 describes
  (`git fetch` + push; never a zip, never `git init` + copy) — the shared
  history is what makes updates work later.
- Then read `CLAUDE.md` and `README.md` before continuing.
- Walk the user through the steps below **one at a time, in order**.
  Before each step say what it does and what the user must do themselves;
  after each step verify the "Done when" before moving on. Do not skip
  ahead, even if the user seems technical.
- **Never ask for the HYROS API key or the password**, and never accept
  them in chat — they go into the app's own setup screen only (step 4).
  Do not stop to ask whether the user "has" the key; it is only needed
  once the app is live.
- Ask for URLs (repo, app) as you need them and verify with
  `https://<app url>/api/setup`.

---

## What this app is (so Claude has the picture)

- A **standalone HYROS dashboard**: Performance Report, CRM / Leads, plus
  plug-in feature tabs (Scale Advisor, Tracking Health, and demo-only
  Funnel & Journey / Ad LTV). Vanilla HTML/JS, no build step, no packages.
- It runs on **Vercel** (free Hobby plan is fine). Vercel functions in
  `api/` call the **HYROS MCP** (`https://mcp.hyros.com/mcp`, built in)
  with the user's HYROS API key, build one snapshot per account, and store
  it in a free **Upstash for Redis** database attached to the Vercel project.
  The browser only ever reads that snapshot.
- **Nothing is configured through environment variables.** The only thing
  Vercel must provide is the Upstash store. Password and HYROS key are
  entered on the app's own first-run screen.
- A **Demo account** with synthetic data is always available, even before
  anything is connected.
- Features are folders under `public/features/<id>/`; `FEATURES.md` is the
  contract and `/add-feature` is the skill. That is for later — setup first.

## What Claude can and cannot do here

- **Can**: run git (fetch the template, push to the user's repo), read and
  explain the code, run `npm run check`, tell the user exactly which
  buttons to click in GitHub / Vercel / HYROS, and verify each step by
  asking for the app URL and reading `https://<url>/api/setup` — a public
  JSON status that moves `needs_storage` → `needs_setup` → `ready`.
- **Cannot**: click inside HYROS, GitHub or Vercel, or see the API key.
  The user must never paste the HYROS API key or the password into the
  chat — they go into the app's setup screen only. If they do paste one,
  tell them to rotate it (HYROS → Settings → API) and do not store it.

## Claude Code on the web vs on your computer

Both work. The steps are the same; only step 1 differs slightly.

| | **claude.ai/code (web)** — recommended if you are not technical | **Claude Code on your computer** |
|---|---|---|
| Where the repo lives | You open your empty GitHub repo in the session; it is already checked out | Claude clones it into a folder; needs `git` and a GitHub login (`gh auth login`) |
| Local preview (`node scripts/devserver.mjs`) | not available — skip anything marked *local only* | works |
| Verifying `/api/setup` | Claude fetches the URL; if the sandbox blocks it, paste the JSON you see in the browser | Claude fetches the URL |

---

## The steps

Each step has a **Goal**, **You do**, **Claude does**, and **Done when**.
Claude confirms the previous step's "done when" before continuing.

### Step 0 — Your empty GitHub repo
- **Goal**: a repo you own for Vercel to deploy from.
- **You do**: on github.com → **New repository** → name it (e.g.
  `hyros-ai`), private is fine, **do not** tick "Add a README",
  ".gitignore" or "license" — leave it completely empty. Copy its URL.
  Then open Claude Code (web: pick this repo when starting the session;
  computer: open an empty folder) and paste the prompt above with your
  repo URL filled in.
- **Claude does**: nothing yet — this is the human's step.
- **Done when**: the prompt is sent and Claude has the repo URL.

### Step 1 — Copy the template into your repo (Claude does this)
- **Goal**: your repo contains the app, with the template's git history,
  so updates later are a plain merge.
- **You do**: nothing, unless git asks you to log in to GitHub.
- **Claude does**, in the checkout of the user's repo (web: the session
  folder; computer: `git clone <user repo url>` first, or `git init` in an
  empty folder and `git remote add origin <user repo url>`):
  ```
  git remote add upstream https://github.com/Hyros-AI/hyros-ai.git
  git fetch upstream
  git checkout -b master upstream/master      # repo is empty (the normal case)
  git push -u origin master
  ```
  If the user's repo already has a commit (they ticked "Add a README"),
  replace the `checkout` line with
  `git merge upstream/master --allow-unrelated-histories`; it will report
  an add/add conflict on `README.md` — take the template's copy
  (`git checkout upstream/master -- README.md && git add README.md &&
  git commit -m "Copy AI HYROS template"`) and push the current branch.
  Then run `npm run check` (Node 20+, nothing to install) and report "all
  checks pass". Do not squash, re-init or copy
  files by hand — the shared history is what makes `git merge upstream/master`
  work in step 6.
- **Done when**: on GitHub the user's repo shows `api/`, `public/`,
  `vercel.json` and `package.json` at the top level (not inside a
  subfolder), and `npm run check` passes. *Local only, optional*:
  `node scripts/devserver.mjs` → `http://127.0.0.1:4321`, password `dev`,
  look at the Demo account.

### Step 2 — Deploy to Vercel
- **Goal**: the app is live at a `*.vercel.app` URL.
- **You do**: vercel.com → **Add New → Project** → **Import** the GitHub
  repo from step 1 (connect your GitHub account to Vercel if asked).
  Leave every setting as Vercel shows it — `vercel.json` already sets the
  framework (none) and the output directory (`public`). No environment
  variables. Click **Deploy**, then copy the deployment URL and paste it
  here.
- **Claude does**: reads `https://<url>/api/setup` and expects
  `"state":"needs_storage"` — the store is added next.
- **Done when**: the URL loads and shows the Demo dashboard under a
  "Storage needs to be set up" card. That is correct; go to step 3.

### Step 3 — Set up storage (Upstash for Redis)
- **Goal**: the app has a database for snapshots, keys and the password.
- **You do**: Vercel → the project → **Storage** tab → **Create Database**
  → **Upstash for Redis** (Marketplace, free plan) → Continue → connect
  to this project for **all environments**. Vercel adds the connection
  variables itself (`KV_REST_API_*` or `UPSTASH_REDIS_REST_*`); you never
  type any. **It must be Upstash for Redis**: the marketplace also lists a
  product called just "Redis" (Redis Cloud, `REDIS_URL`), which the app
  does not speak. Then **Deployments → latest → ⋯ → Redeploy** (required —
  functions read variables only at deploy time). Pull-request previews
  share this store but are read-only (they never overwrite the live
  snapshot); connect it to Production only if previews must not see live
  data.
- **Claude does**: after the redeploy, reads `/api/setup` again and
  expects `"storage":true` and `"state":"needs_setup"`. If it still says
  `needs_storage`, the redeploy was skipped or the store is connected to a
  different environment — Claude tells you which to check.
- **Done when**: the app opens on "Connect your HYROS account" (or you
  click **Check again** on the storage screen and it advances).

### Step 4 — Connect your HYROS account
- **Goal**: the dashboard is yours.
- **You do**: in HYROS go to **Settings → API** and copy your API key.
  Open your app URL **now** (the connect screen is first-come), paste the
  key there, tick "agency key" if it is one (it adds every client account
  you can access), type a password twice, click **Connect & build my
  dashboard**. The key is checked with HYROS first (a bad key changes
  nothing), then everything is stored and the first snapshot builds —
  usually a minute or two, up to 5 minutes on a large account. The key and
  the password go into that screen only, never into this chat.
- **Claude does**: reads `/api/setup` and expects `"state":"ready"`. Asks
  you whether the report shows your ad accounts and the badge reads
  **Live**.
- **Done when**: you see your own numbers.

### Step 5 — Optional: lock it down, add accounts
- **Hardening** (optional): the last setup screen shows two generated
  secrets with copy buttons. Vercel → Settings → Environment Variables →
  add `ACCOUNT_KEY_SECRET` and `CRON_SECRET` with those values → Redeploy
  → click **I added them**. Claude expects `"pendingSecrets":false`
  afterwards. Everything works without this step.
- **More accounts**: account menu (top left) → **+ Add account**.
- **Daily refresh**: automatic (Vercel cron). Without `CRON_SECRET` it is
  limited to once per hour; with it, signed.
- **Start over**: account menu → Setup & security → type `RESET`.

### Step 6 — Later: updates and new features
- **Updates**: the template moves on; your repo keeps the `upstream`
  remote from step 1, so bringing in a new version is one prompt to
  Claude — *"Pull the latest AI HYROS template from upstream, resolve any
  conflicts, and push"* — which runs
  `git fetch upstream && git merge upstream/master && git push`. Vercel
  redeploys on push. If the dashboard then says "old snapshot — needs a
  Refresh", press **Refresh**.
- **Features**: ask Claude to read `FEATURES.md` and use `/add-feature`.
  Every tab is a folder under `public/features/<id>/`; `npm run check`
  enforces the contract; `node scripts/feature-pack.mjs <id>` exports a
  feature for another fork.

---

## Where I am (fill in and keep updated)

```
Step:            ___
My GitHub repo:  https://github.com/________/________
App URL:         https://________________.vercel.app
Agency key?:     yes / no
Last /api/setup: { state: "________" }
Blocked on:      ________________________________
```

## If something goes wrong

| Symptom | Likely cause | What Claude should do |
|---|---|---|
| `git push` rejected / asks for login | no GitHub credential on the machine | computer: `gh auth login` and retry; web: the session must have been opened on that repo |
| `git merge` says "refusing to merge unrelated histories" | the repo was not empty (README commit) or was set up from a zip | `git merge upstream/master --allow-unrelated-histories`; on the `README.md` add/add conflict take the template's copy (`git checkout upstream/master -- README.md`), commit, push |
| `/api/setup` returns 404 | functions not deployed — usually the files are inside an extra top-level folder | move the files up (they must be at the repo root), or set Vercel → Settings → General → Root Directory to that folder; redeploy |
| still `needs_storage` after adding the store | no redeploy, or store connected to another project/env, or "Redis" (Redis Cloud) was picked instead of Upstash | Storage → database → Projects; make sure it is Upstash for Redis; redeploy |
| "HYROS rejected that key" | key mistyped or copied from the wrong account | copy again from HYROS Settings → API; nothing was stored |
| "the key is valid but MCP access is not enabled" | MCP is granted per account by HYROS | ask HYROS support to enable MCP on the account, then retry; nothing was stored |
| first build times out | very large account | press Refresh again; the lead sync is incremental and every refresh keeps what the previous one fetched |
| sign-in screen instead of connect screen on a fresh deploy | an older deployment already set a password in this store | Setup & security → RESET (or `REPORT_PASSWORD` in Vercel as a master password if locked out) |
