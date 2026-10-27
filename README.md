# 🎁 Ønskeliste (wishlistr)

A tiny static wishlist. Family opens a link, sees the wishes, and can **wrap** one to
reserve it so nobody buys the same thing twice — and unwrap it if they change their mind.
No logins, no tokens for family, no build step, no frameworks.

- **Page:** `index.html` (single file, inline CSS + JS, one Google Font)
- **Data:** `wishes.csv` in this repo
- **Family write path:** a Cloudflare Worker in `worker/` (holds the GitHub token server-side)
- **Served at:** https://wonderdk.github.io/wishlistr/

## How it works

- **First screen (landing):** the first thing a visitor sees is a choice — **Se ønskeseddel**
  (the family view) or **Rediger ønskeseddel** (owner view). "Rediger" is gated behind a
  password (`EDIT_PASSWORD` in `index.html`, currently `Mountainbike`). The choice is
  remembered for the browser session, so a reload does not ask again. `?owner=1` still opens
  owner view directly and skips the landing.
- **Reading:** the page fetches `wishes.csv` through the unauthenticated GitHub Contents API,
  so family always sees the current state immediately (not a cached Pages build). It falls
  back to the relative `wishes.csv` if the API is rate-limited, and re-fetches when the tab
  regains focus.
- **Wrapping / unwrapping (family):** the page has **no** GitHub token. It POSTs
  `{ id, action, device, force }` to the Worker with an `X-Wishlist-Key` header. The Worker
  validates the key, edits the single row in `wishes.csv`, and commits it. `device` is a
  random id generated once per browser (localStorage) — never a name. Removing a reservation
  asks the family member to type **FJERN** to confirm, so it can't happen by accident.
- **Owner view (landing → "Rediger ønskeseddel", or `?owner=1`):** hides all wrapped state and
  the wrap buttons, and shows **Add wish** / **Edit** forms that write `wishes.csv` directly
  through the Contents API. The `EDIT_PASSWORD` gate is a soft gate (the page is public); the
  owner still needs a GitHub token to actually save. Owner view prompts once for that token
  (stored only in that browser). Owner edits
  re-read the file right before writing and **never touch** `reserved` / `reserved_by` /
  `reserved_at`. The CSV is public, so hiding wrapped state in owner view is honour-system only.

## `wishes.csv` columns

```
id,title,description,url,image,price,currency,priority,category,reserved,reserved_by,reserved_at
```

- `id` — short stable slug, never reused
- `priority` — 1–3 (3 = most wanted)
- `reserved` — 0 or 1
- `reserved_by` — anonymous per-browser device id, never a name
- `reserved_at` — ISO timestamp

---

## Setup

### 1. Configure the page

In `index.html`, near the top of the `<script>`:

- `OWNER_NAME` — the wishlist owner's name (shown in the header). **Currently `"Steven"` — change if needed.**
- `EDIT_PASSWORD` — the password for **Rediger ønskeseddel** (edit mode) on the landing page.
  **Currently `"Mountainbike"`.** Case-insensitive; it is a soft gate (the page is public), not a real secret.
- `RESERVE_ENDPOINT` — set to your deployed Worker URL once step 3 is done
  (e.g. `https://wishlistr.<your-subdomain>.workers.dev`).
- `WISHLIST_KEY` — the shared key. It is **embedded in the public page**, so it is not a real
  secret; it is a soft gate that keeps casual/bot traffic off the Worker. It must match the
  `WISHLIST_KEY` secret you set on the Worker.

### 2. Create a GitHub token (for the Worker and for owner view)

1. GitHub → **Settings → Developer settings → Fine-grained personal access tokens → Generate new token**.
2. **Resource owner:** `wonderdk`. **Repository access:** only `wonderdk/wishlistr`.
3. **Permissions → Repository permissions → Contents: Read and write**.
4. Generate and copy the token. Use the same token as the Worker's `GITHUB_TOKEN` secret,
   and (for owner view) paste it when the page prompts you — it is stored only in your browser.

> Tip: give it a short expiry and regenerate when it lapses.

### 3. Deploy the Worker (Cloudflare Workers Builds — no local wrangler needed)

The Worker builds and deploys from this repo via Cloudflare's Git integration.

1. Cloudflare dashboard → **Workers & Pages → Create → Workers → Import a repository**
   (connect GitHub and pick `wonderdk/wishlistr`).
2. **Build configuration:**
   - **Root directory:** `worker`
   - **Deploy command:** `npx wrangler deploy`
   - (Build command can be left empty.)
3. Create the Worker. Note its URL (`https://wishlistr.<your-subdomain>.workers.dev`) and put it
   in `RESERVE_ENDPOINT` in `index.html` (step 1), then commit/push.
4. **Add the secrets:** Worker → **Settings → Variables and Secrets → Add** (type: *Secret*):
   - `GITHUB_TOKEN` — the token from step 2
   - `WISHLIST_KEY` — the same value as `WISHLIST_KEY` in `index.html`
5. Re-deploy if needed so the secrets are picked up (Workers Builds redeploys on each push to `main`).

The Worker only accepts requests from the `https://wonderdk.github.io` origin (CORS) and only
when the `X-Wishlist-Key` header matches the `WISHLIST_KEY` secret.

### 4. Enable GitHub Pages

Repo → **Settings → Pages**:

- **Source:** *Deploy from a branch*
- **Branch:** `main` / `/ (root)`
- Save. The site publishes at **https://wonderdk.github.io/wishlistr/**.

### 5. Share the link

Send family the plain link: **https://wonderdk.github.io/wishlistr/**. They land on the
front page and tap **Se ønskeseddel** — then they can reserve/unreserve straight away, no
sign-in and no tokens.

You tap **Rediger ønskeseddel** and enter the `EDIT_PASSWORD` (`Mountainbike`) to add and edit
wishes — or open **https://wonderdk.github.io/wishlistr/?owner=1** to go straight there. Either
way you will not see what is reserved.

---

## Project layout

```
index.html          the whole app (family + owner views)
wishes.csv          the data
worker/
  src/index.js      the reservation Worker
  wrangler.toml     name, main, compatibility_date (no secrets here)
  package.json      wrangler as a devDependency
```

## Local Worker dev (optional)

```bash
cd worker
npm install
# put secrets in worker/.dev.vars (gitignored): GITHUB_TOKEN=... and WISHLIST_KEY=...
npx wrangler dev
```
