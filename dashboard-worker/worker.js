/* ══════════════════════════════════════════════════════════════
   urlsify-dashboard — account-only API for dashboard.html

   Separate from urlsify-worker. That worker owns the public
   shortener and the redirect path and is NOT touched by this one.

   Shared state: the same LINKS KV namespace, bound read/write here.
   Everything this worker writes is additive — new key prefixes plus
   expiry metadata — so the existing worker keeps behaving exactly
   as it does today.

   Mount: either works, the paths below are relative to it —
     urlsify.com/api/dash/*  (recommended: same-origin, no CORS)
     urlsifydash.<sub>.workers.dev/*

   Endpoints — all require a Supabase Bearer token except /health:
     GET    /health
     POST   /shorten          { url, slug?, ttl?, tag? }
     GET    /links            list this account's links
     PATCH  /links/:code      { url?, ttl?, tag? }
     DELETE /links/:code
     POST   /signup          announce a new account (once per user)
     DELETE /account         { purge? } wipe links, notify, optionally
                             delete the Supabase auth record
   ══════════════════════════════════════════════════════════════ */

const SITE = "https://urlsify.com";
const YEAR = 60 * 60 * 24 * 365;
const MAX_TTL = YEAR * 2;
const MIN_TTL = 60; // Cloudflare KV floor

/* Slugs that must never shadow a real page or API path. */
const RESERVED_SLUGS = new Set([
  "api", "admin", "stats", "shorten", "health", "dash",
  "about", "pricing", "dashboard", "contact", "terms", "privacy",
  "auth", "login", "signup", "index", "app", "assets",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsFor(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Works either mounted at urlsify.com/api/dash/* or served straight
    // from the workers.dev subdomain, so the route choice is free.
    const path = url.pathname.startsWith("/api/dash")
      ? url.pathname.slice("/api/dash".length) || "/"
      : url.pathname;

    // ── health: no auth, so the dashboard can detect a bad deploy ──
    if (path === "/health") {
      return json({ ok: true, worker: "urlsify-dashboard" }, 200, cors);
    }

    // ── everything below is account-only ──────────────────────────
    const claims = await getClaims(request, env);

    if (!claims) {
      return json({ error: "Sign in to manage links." }, 401, cors);
    }

    const userId = claims.sub;

    try {
      if (path === "/shorten" && request.method === "POST") {
        return await createLink(request, env, cors, userId);
      }

      if (path === "/links" && request.method === "GET") {
        return await listLinks(env, cors, userId);
      }

      if (path === "/signup" && request.method === "POST") {
        return await announceSignup(env, cors, claims);
      }

      if (path === "/account" && request.method === "DELETE") {
        return await deleteAccount(request, env, cors, claims);
      }

      if (path.startsWith("/links/")) {
        const code = decodeURIComponent(path.slice("/links/".length));

        if (!code) return json({ error: "Missing link code" }, 400, cors);

        if (request.method === "PATCH") {
          return await updateLink(request, env, cors, userId, code);
        }

        if (request.method === "DELETE") {
          return await deleteLink(env, cors, userId, code);
        }
      }
    } catch (err) {
      return json({ error: err.message || "Request failed" }, 400, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  },
};

/* ══ ENDPOINTS ═══════════════════════════════════════════════════ */

async function createLink(request, env, cors, userId) {
  const body = await request.json();
  const longUrl = (body.url ?? "").trim();
  const requested = (body.slug ?? "").trim().toLowerCase();
  const tag = (body.tag ?? "").toString().slice(0, 40) || null;
  const ttl = clampTtl(body.ttl);

  let parsed;

  try {
    parsed = new URL(longUrl);
  } catch {
    return json({ error: "Invalid URL" }, 400, cors);
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return json({ error: "Only http and https links can be shortened." }, 400, cors);
  }

  if (parsed.hostname === "urlsify.com" || parsed.hostname.endsWith(".urlsify.com")) {
    return json({ error: "You can't shorten a urlsify.com link." }, 400, cors);
  }

  let code = requested;

  if (code) {
    if (!/^[a-z0-9_-]{3,30}$/.test(code)) {
      return json(
        {
          error:
            "Custom slug must be 3–30 characters and only contain letters, numbers, hyphens, or underscores.",
        },
        400,
        cors
      );
    }

    if (RESERVED_SLUGS.has(code)) {
      return json({ error: "That slug is reserved. Please choose another." }, 400, cors);
    }

    if (await env.LINKS.get(code)) {
      return json({ error: "That custom link is already taken. Try another." }, 409, cors);
    }
  } else {
    code = await freeRandomCode(env);

    if (!code) {
      return json({ error: "Could not allocate a slug. Try again." }, 503, cors);
    }
  }

  const exp = Date.now() + ttl * 1000;

  await Promise.all([
    // Same key shape the shortener reads — plus an expiry stamp it ignores.
    env.LINKS.put(code, longUrl, { expirationTtl: ttl, metadata: { exp } }),
    env.LINKS.put(`clicks:${code}`, "0", { expirationTtl: ttl }),
    // Ownership, both directions: by code for auth checks, by user for listing.
    env.LINKS.put(`owner:${code}`, userId, { expirationTtl: ttl }),
    env.LINKS.put(`u:${userId}:${code}`, tag ?? "", { expirationTtl: ttl, metadata: { exp, tag } }),
  ]);

  await notifyDiscord(env, code, longUrl);

  return json(
    {
      code,
      short: `${SITE}/${code}`,
      destination: longUrl,
      tag,
      expiresAt: new Date(exp).toISOString(),
    },
    200,
    cors
  );
}

/* Recovery / cross-device listing. Supabase is the primary library;
   this exists so a link is never lost if that write failed. */
async function listLinks(env, cors, userId) {
  const prefix = `u:${userId}:`;
  const listed = await env.LINKS.list({ prefix, limit: 1000 });

  const links = listed.keys.map((k) => {
    const code = k.name.slice(prefix.length);
    const exp = k.metadata?.exp ?? null;

    return {
      code,
      short: `${SITE}/${code}`,
      tag: k.metadata?.tag ?? null,
      expiresAt: exp ? new Date(exp).toISOString() : null,
    };
  });

  return json({ links, complete: listed.list_complete !== false }, 200, cors);
}

async function updateLink(request, env, cors, userId, code) {
  const owned = await assertOwner(env, userId, code);

  if (owned.error) return json({ error: owned.error }, owned.status, cors);

  const patch = await request.json();
  let destination = owned.value;

  if (patch.url !== undefined) {
    let parsed;

    try {
      parsed = new URL(patch.url);
    } catch {
      return json({ error: "Invalid URL" }, 400, cors);
    }

    if (!/^https?:$/.test(parsed.protocol)) {
      return json({ error: "Only http and https links are allowed." }, 400, cors);
    }

    if (parsed.hostname === "urlsify.com" || parsed.hostname.endsWith(".urlsify.com")) {
      return json({ error: "You can't point a link at urlsify.com." }, 400, cors);
    }

    destination = patch.url;
  }

  // KV cannot change a TTL in place, so the keys are rewritten.
  // With no explicit ttl the remaining lifetime is preserved rather
  // than silently reset to a fresh year.
  const ttl = patch.ttl === undefined ? remainingTtl(owned.metadata) : clampTtl(patch.ttl);
  const tag = patch.tag === undefined ? owned.tag : (patch.tag || null);
  const exp = Date.now() + ttl * 1000;
  const clicks = (await env.LINKS.get(`clicks:${code}`)) ?? "0";

  await Promise.all([
    env.LINKS.put(code, destination, { expirationTtl: ttl, metadata: { exp } }),
    env.LINKS.put(`clicks:${code}`, clicks, { expirationTtl: ttl }),
    env.LINKS.put(`owner:${code}`, userId, { expirationTtl: ttl }),
    env.LINKS.put(`u:${userId}:${code}`, tag ?? "", { expirationTtl: ttl, metadata: { exp, tag } }),
  ]);

  return json(
    {
      code,
      short: `${SITE}/${code}`,
      destination,
      tag,
      expiresAt: new Date(exp).toISOString(),
    },
    200,
    cors
  );
}

async function deleteLink(env, cors, userId, code) {
  const owned = await assertOwner(env, userId, code);

  if (owned.error) return json({ error: owned.error }, owned.status, cors);

  await Promise.all([
    env.LINKS.delete(code),
    env.LINKS.delete(`clicks:${code}`),
    env.LINKS.delete(`owner:${code}`),
    env.LINKS.delete(`u:${userId}:${code}`),
    env.LINKS.delete(`countries:${code}`),
    env.LINKS.delete(`browsers:${code}`),
    env.LINKS.delete(`devices:${code}`),
    env.LINKS.delete(`referrers:${code}`),
  ]);

  return json({ deleted: true, code }, 200, cors);
}


/* ══ ACCOUNT ═════════════════════════════════════════════════════

   Both of these notify the operator's webhook server-side. The URL
   lives in worker config, never in page source, and the email comes
   from the verified JWT rather than the request body — so neither
   can be spoofed or abused by anyone reading the site's JS.
   ═══════════════════════════════════════════════════════════════ */

async function announceSignup(env, cors, claims) {
  const userId = claims.sub;
  const marker = `signup:${userId}`;

  // fires once per account, however many times the page calls it
  if (await env.LINKS.get(marker)) {
    return json({ announced: false, reason: "already recorded" }, 200, cors);
  }

  await env.LINKS.put(marker, new Date().toISOString());

  await postWebhook(env, {
    title: "🎉 New account",
    color: 0x4ade80,
    fields: [
      { name: "Email", value: claims.email || "unknown", inline: false },
      { name: "User ID", value: userId, inline: false },
    ],
  });

  return json({ announced: true }, 200, cors);
}

async function deleteAccount(request, env, cors, claims) {
  const userId = claims.sub;
  const body = await request.json().catch(() => ({}));
  const purge = body.purge === true;

  // Always remove the account's links — an account that no longer
  // exists must not leave live redirects behind.
  const prefix = `u:${userId}:`;
  const listed = await env.LINKS.list({ prefix, limit: 1000 });
  const codes = listed.keys.map((k) => k.name.slice(prefix.length));

  for (const code of codes) {
    const owner = await env.LINKS.get(`owner:${code}`);

    if (owner !== userId) continue; // never touch someone else's link

    await Promise.all([
      env.LINKS.delete(code),
      env.LINKS.delete(`clicks:${code}`),
      env.LINKS.delete(`owner:${code}`),
      env.LINKS.delete(`u:${userId}:${code}`),
      env.LINKS.delete(`countries:${code}`),
      env.LINKS.delete(`browsers:${code}`),
      env.LINKS.delete(`devices:${code}`),
      env.LINKS.delete(`referrers:${code}`),
    ]);
  }

  await env.LINKS.delete(`signup:${userId}`);

  // Full erasure needs admin rights, so it only runs when a service
  // role key is configured. Otherwise it is flagged for manual action.
  let authDeleted = false;

  if (purge && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const res = await fetch(`${supabaseBase(env)}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });

      authDeleted = res.ok;
    } catch {
      authDeleted = false;
    }
  }

  await postWebhook(env, {
    title: purge ? "🗑️ Account deleted — full erasure requested" : "🗑️ Account deleted",
    color: 0xff6b6b,
    fields: [
      { name: "Email", value: claims.email || "unknown", inline: false },
      { name: "User ID", value: userId, inline: false },
      { name: "Links removed", value: String(codes.length), inline: true },
      { name: "Erase all data", value: purge ? "yes" : "no", inline: true },
      {
        name: "Auth record",
        value: authDeleted
          ? "deleted automatically"
          : purge
            ? "**needs manual deletion**"
            : "retained",
        inline: false,
      },
    ],
  });

  return json({ deleted: true, links: codes.length, authDeleted, purge }, 200, cors);
}

/* ══ OWNERSHIP ═══════════════════════════════════════════════════ */

async function assertOwner(env, userId, code) {
  const owner = await env.LINKS.get(`owner:${code}`);

  if (!owner) {
    return {
      error: "That link was made without an account, so it can't be managed here.",
      status: 403,
    };
  }

  if (owner !== userId) {
    return { error: "That link belongs to another account.", status: 403 };
  }

  const { value, metadata } = await env.LINKS.getWithMetadata(code);

  if (!value) {
    return { error: "Link not found or already expired.", status: 404 };
  }

  const idx = await env.LINKS.getWithMetadata(`u:${userId}:${code}`);

  return { value, metadata, tag: idx.metadata?.tag ?? null };
}

/* ══ AUTH — Supabase JWT, verified against the project JWKS ══════ */

async function getClaims(request, env) {
  const header = request.headers.get("authorization") ?? "";

  if (!header.toLowerCase().startsWith("bearer ")) return null;

  const token = header.slice(7).trim();

  if (!token) return null;

  try {
    const [rawHeader, rawPayload, rawSig] = token.split(".");

    if (!rawHeader || !rawPayload || !rawSig) return null;

    const head = JSON.parse(b64urlToText(rawHeader));
    const payload = JSON.parse(b64urlToText(rawPayload));

    // expiry, allowing a little clock skew
    if (!payload.exp || payload.exp * 1000 < Date.now() - 5000) return null;
    if (!payload.sub) return null;

    const base = supabaseBase(env);

    // the token must have been issued by *our* project
    if (payload.iss && !payload.iss.startsWith(base)) return null;

    const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    const sig = b64urlToBytes(rawSig);

    if (head.alg === "HS256") {
      // legacy symmetric projects only; unused while the project uses ES256
      if (!env.SUPABASE_JWT_SECRET) return null;

      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );

      return (await crypto.subtle.verify("HMAC", key, sig, signed)) ? payload : null;
    }

    if (head.alg !== "ES256" && head.alg !== "RS256") return null;

    const jwk = await getJwk(env, head.kid);

    if (!jwk) return null;

    const importAlgo =
      head.alg === "ES256"
        ? { name: "ECDSA", namedCurve: "P-256" }
        : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

    const verifyAlgo =
      head.alg === "ES256"
        ? { name: "ECDSA", hash: "SHA-256" }
        : { name: "RSASSA-PKCS1-v1_5" };

    const key = await crypto.subtle.importKey("jwk", jwk, importAlgo, false, ["verify"]);

    return (await crypto.subtle.verify(verifyAlgo, key, sig, signed)) ? payload : null;
  } catch {
    return null;
  }
}

let jwksCache = { keys: null, at: 0 };

async function getJwk(env, kid) {
  const fresh = Date.now() - jwksCache.at < 10 * 60 * 1000;

  if (!jwksCache.keys || !fresh) {
    const res = await fetch(`${supabaseBase(env)}/auth/v1/.well-known/jwks.json`);

    if (!res.ok) return null;

    const body = await res.json();

    jwksCache = { keys: body.keys ?? [], at: Date.now() };
  }

  if (!kid) return jwksCache.keys[0] ?? null;

  return jwksCache.keys.find((k) => k.kid === kid) ?? null;
}

function supabaseBase(env) {
  return (env.SUPABASE_URL ?? "https://ytvyhkhzewnultjfpcyf.supabase.co").replace(/\/+$/, "");
}

/* ══ HELPERS ═════════════════════════════════════════════════════ */

function corsFor(request) {
  const origin = request.headers.get("origin") ?? "";
  const allowed =
    origin === SITE ||
    origin === "https://www.urlsify.com" ||
    origin.endsWith(".workers.dev");

  return {
    "Access-Control-Allow-Origin": allowed ? origin : SITE,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, cors) {
  return Response.json(body, { status, headers: cors });
}

function clampTtl(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) return YEAR;

  return Math.min(Math.max(Math.floor(n), MIN_TTL), MAX_TTL);
}

function remainingTtl(metadata) {
  if (!metadata || !metadata.exp) return YEAR;

  return clampTtl(Math.floor((metadata.exp - Date.now()) / 1000));
}

async function freeRandomCode(env) {
  for (let i = 0; i < 6; i++) {
    const code = randomCode();

    if (!(await env.LINKS.get(code))) return code;
  }

  return null;
}

function randomCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));

  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/* Account events (signups, deletions) — same DISCORD_WEBHOOK the
   link notifications use, configured in the worker's variables. */
async function postWebhook(env, embed) {
  const hook = env.DISCORD_WEBHOOK;

  if (!hook) return;

  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            ...embed,
            timestamp: new Date().toISOString(),
            footer: { text: "urlsify.com · accounts" },
          },
        ],
      }),
    });
  } catch {
    // a failed notification must never fail the user's action
  }
}

/* Same notification the shortener sends, so account-made links still
   show up in Discord. */
async function notifyDiscord(env, code, destination) {
  await postWebhook(env, {
    title: "🔗 New Link Created! (dashboard)",
    color: 0x7c6bff,
    fields: [
      { name: "✂️ Short Link", value: `${SITE}/${code}`, inline: false },
      { name: "🌐 Destination", value: destination, inline: false },
    ],
  });
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);

  return out;
}

function b64urlToText(str) {
  return new TextDecoder().decode(b64urlToBytes(str));
}
