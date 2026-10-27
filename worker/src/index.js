/**
 * wishlistr reservation Worker
 * ----------------------------
 * The public page never holds a GitHub token. It POSTs { id, action, device, force }
 * here with an "X-Wishlist-Key" header; this Worker holds the real GitHub token
 * (GITHUB_TOKEN secret) and performs the write against wishes.csv.
 *
 * Secrets (set in the Cloudflare dashboard, NOT in wrangler.toml):
 *   GITHUB_TOKEN  - fine-grained PAT with Contents: Read and write on wonderdk/wishlistr
 *   WISHLIST_KEY  - must match the WISHLIST_KEY constant in index.html
 */

const REPO = "wonderdk/wishlistr";
const BRANCH = "main";
const CSV_PATH = "wishes.csv";
const GITHUB_API = `https://api.github.com/repos/${REPO}/contents/${CSV_PATH}`;
const ALLOW_ORIGIN = "https://wonderdk.github.io";
const COLUMNS = ["id","title","description","url","image","price","currency","priority","category","reserved","reserved_by","reserved_at"];

export default {
  async fetch(request, env) {
    // ---- CORS preflight: allow the GitHub Pages origin only ----
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    // ---- Shared-key gate (trim guards against a stray newline/space in the stored secret) ----
    if ((request.headers.get("X-Wishlist-Key") || "").trim() !== (env.WISHLIST_KEY || "").trim()) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    // ---- Validate body ----
    let body;
    try { body = await request.json(); }
    catch (_) { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const id = typeof body.id === "string" ? body.id.trim() : "";
    const action = body.action;
    const device = typeof body.device === "string" ? body.device.trim() : "";
    const force = body.force === true;

    if (!id) return json({ ok: false, error: "Missing id" }, 400);
    if (action !== "wrap" && action !== "unwrap") return json({ ok: false, error: "Invalid action" }, 400);
    if (action === "wrap" && !device) return json({ ok: false, error: "Missing device" }, 400);
    if (!env.GITHUB_TOKEN) return json({ ok: false, error: "Server not configured" }, 500);

    try {
      const row = await mutate(env, id, action, device, force);
      return json({
        ok: true,
        reserved: row.reserved === "1",
        reserved_by: row.reserved_by || "",
        reserved_at: row.reserved_at || "",
      });
    } catch (e) {
      const status = e.status || 500;
      return json({ ok: false, error: e.message || "Server error" }, status);
    }
  },
};

/**
 * Reads wishes.csv, applies the single-row change, and writes it back.
 * Retries once on a 409 (stale sha) by refetching. Never touches any other
 * column or row: every other cell is preserved verbatim through parse/serialize.
 */
async function mutate(env, id, action, device, force, attempt = 0) {
  const meta = await ghGet(env, `${GITHUB_API}?ref=${BRANCH}`);
  if (!meta.ok) throw httpError(`Could not read wishes.csv (${meta.status})`, 502);
  const metaJson = await meta.json();
  const sha = metaJson.sha;
  const rows = parseCSV(b64decodeUtf8(metaJson.content));

  const row = rows.find(r => r.id === id);
  if (!row) throw httpError("Wish not found", 404);

  if (action === "wrap") {
    if (row.reserved === "1" && row.reserved_by !== device && !force) {
      throw httpError("Already wrapped by someone else", 409);
    }
    row.reserved = "1";
    row.reserved_by = device;
    row.reserved_at = new Date().toISOString();
  } else { // unwrap
    row.reserved = "0";
    row.reserved_by = "";
    row.reserved_at = "";
  }

  const csv = buildCsv(rows);
  const put = await ghPut(env, {
    message: `${action === "wrap" ? "Wrap" : "Unwrap"}: ${id}`,
    content: b64encodeUtf8(csv),
    sha,
    branch: BRANCH,
  });

  if (!put.ok) {
    if (put.status === 409 && attempt === 0) {
      return mutate(env, id, action, device, force, 1); // sha raced another write: refetch + retry once
    }
    const err = await put.json().catch(() => ({}));
    throw httpError(`GitHub write failed (${put.status})${err.message ? ": " + err.message : ""}`, 502);
  }
  return row;
}

/* ---------- GitHub helpers ---------- */
function ghHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "wishlistr-worker",
  };
}
function ghGet(env, url) {
  return fetch(url, { headers: ghHeaders(env), cf: { cacheTtl: 0 } });
}
function ghPut(env, payload) {
  return fetch(GITHUB_API, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/* ---------- CSV (same parser/serializer as index.html) ---------- */
function parseCSV(text) {
  const records = [];
  let row = [], cur = "", inQ = false;
  const t = (text || "").replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') { if (t[i+1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i+1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some(v => v !== "")) records.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(v => v !== "")) records.push(row);
  if (!records.length) return [];
  const headers = records[0].map(h => h.trim());
  return records.slice(1).map(vals => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] != null ? vals[i] : "").trim());
    COLUMNS.forEach(c => { if (!(c in obj)) obj[c] = ""; });
    return obj;
  });
}
function csvCell(v) {
  v = (v == null ? "" : String(v));
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function buildCsv(rows) {
  const header = COLUMNS.join(",");
  const body = rows.map(r => COLUMNS.map(c => csvCell(r[c])).join(",")).join("\n");
  return header + "\n" + body + (body ? "\n" : "");
}
function b64decodeUtf8(b64) {
  const bin = atob((b64 || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* ---------- HTTP helpers ---------- */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Wishlist-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
function httpError(message, status) {
  const e = new Error(message); e.status = status; return e;
}
